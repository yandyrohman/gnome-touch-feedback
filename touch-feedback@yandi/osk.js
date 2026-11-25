import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as KeyboardUI from 'resource:///org/gnome/shell/ui/keyboard.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {OSK} from './config.js';

const STATE_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'touch-feedback']);
const STATE_FILE = GLib.build_filenamev([STATE_DIR, 'keyboard.json']);

function loadState() {
    try {
        const [ok, bytes] = GLib.file_get_contents(STATE_FILE);
        if (ok)
            return JSON.parse(new TextDecoder().decode(bytes));
    } catch {}
    return null;
}

function saveState(state) {
    try {
        GLib.mkdir_with_parents(STATE_DIR, 0o755);
        GLib.file_set_contents(STATE_FILE, JSON.stringify(state));
    } catch (e) {
        console.warn(`touch-feedback: gagal simpan posisi keyboard: ${e}`);
    }
}

// Ikuti satu sentuhan/klik dari actor sampai dilepas. Sengaja tanpa
// global.stage.grab(): grab bikin aplikasi kehilangan fokus ketik, lalu GNOME
// langsung nurunin keyboard. Clutter sudah kasih implicit grab untuk
// sentuhan & tombol mouse, jadi event lanjutan tetap ke actor ini.
function attachDrag(actor, {start, move, end}) {
    let origin = null;
    let seq = null;
    actor.connect('event', (_a, event) => {
        const T = Clutter.EventType;
        const type = event.type();
        const isTouch = type === T.TOUCH_BEGIN || type === T.TOUCH_UPDATE ||
            type === T.TOUCH_END || type === T.TOUCH_CANCEL;
        const slot = isTouch ? event.get_event_sequence()?.get_slot() ?? 0 : -1;
        const [x, y] = event.get_coords();
        if (!origin && (type === T.TOUCH_BEGIN || type === T.BUTTON_PRESS)) {
            origin = [x, y];
            seq = slot;
            start();
            return Clutter.EVENT_STOP;
        }
        if (!origin || (isTouch && slot !== seq))
            return origin ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        if (type === T.TOUCH_UPDATE || type === T.MOTION) {
            move(x - origin[0], y - origin[1]);
            return Clutter.EVENT_STOP;
        }
        if (type === T.TOUCH_END || type === T.TOUCH_CANCEL || type === T.BUTTON_RELEASE) {
            origin = null;
            seq = null;
            end();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });
}

// Keyboard layar GNOME dibikin mengambang: bisa digeser dari bar atas,
// di-resize dari pojok kiri/kanan atas, dan muncul dengan slide up.
export class FloatingKeyboard {
    enable() {
        if (!OSK.floating)
            return;
        this._state = loadState();
        this._injections = new InjectionManager();
        const self = this;
        const proto = KeyboardUI.Keyboard.prototype;

        this._injections.overrideMethod(proto, '_relayout', () => function () {
            self._decorate(this);
            self._apply(this);
        });

        this._injections.overrideMethod(proto, '_setFocusWindow', () => function () {
            // Mengambang: jendela nggak perlu didorong ke atas.
            this._focusWindow = null;
            this._focusWindowStartY = null;
        });

        this._injections.overrideMethod(proto, '_animateShow', () => function () {
            global.compositor.disable_unredirect();
            Main.layoutManager.keyboardBox.show();
            self._apply(this);
            this.remove_transition('translation-y');
            this.ease({
                translation_y: self._shownY(this),
                opacity: 255,
                duration: OSK.showDuration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            this._keyboardVisible = true;
            this.emit('visibility-changed');
        });

        // Selama digeser/di-resize, keyboard nggak boleh ditutup.
        this._injections.overrideMethod(proto, 'close', original => function (...args) {
            if (this._tfDragging)
                return;
            original.apply(this, args);
        });

        this._injections.overrideMethod(proto, '_animateHide', () => function () {
            if (this._tfDragging)
                return;
            this.ease({
                translation_y: 0,
                opacity: 0,
                duration: OSK.hideDuration,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onComplete: () => this._animateHideComplete(),
            });
            this._keyboardVisible = false;
            this.emit('visibility-changed');
        });

        this._injections.overrideMethod(proto, 'gestureProgress', () => function (delta) {
            this._gestureInProgress = true;
            Main.layoutManager.keyboardBox.show();
            self._apply(this);
            const target = -self._shownY(this);
            const p = Math.min(delta, target) / target;
            this.translation_y = -target * p;
            this.opacity = 255 * p;
        });

        const kb = Main.keyboard.keyboardActor;
        if (kb) {
            kb._relayout();
            if (kb._keyboardVisible)
                kb.translation_y = this._shownY(kb);
        }
    }

    disable() {
        if (!this._injections)
            return;
        this._injections.clear();
        this._injections = null;
        const kb = Main.keyboard.keyboardActor;
        if (kb) {
            kb._tfHeader?.destroy();
            kb._tfHeader = null;
            kb.remove_style_class_name('tf-floating');
            kb.translation_x = 0;
            kb._relayout();
            if (kb._keyboardVisible)
                kb.translation_y = -kb.height;
        }
    }

    _monitor() {
        return Main.layoutManager.keyboardMonitor;
    }

    _geometry() {
        const mon = this._monitor();
        const s = this._state ?? {};
        let w = s.w ?? Math.round(mon.width * OSK.defaultWidth);
        w = Math.clamp(w, Math.min(OSK.minWidth, mon.width), mon.width);
        let h = s.h ?? Math.round(w * OSK.defaultAspect);
        h = Math.clamp(h, Math.min(OSK.minHeight, mon.height), Math.round(mon.height * 0.7));
        const x = Math.clamp(s.x ?? Math.round((mon.width - w) / 2), 0, mon.width - w);
        const bottom = Math.clamp(s.bottom ?? OSK.defaultBottom, 0, mon.height - h);
        return {w, h, x, bottom};
    }

    _shownY(kb) {
        return -(kb.height + this._geometry().bottom);
    }

    _apply(kb) {
        if (!this._monitor())
            return;
        const g = this._geometry();
        kb.width = g.w;
        kb.height = g.h;
        kb.translation_x = g.x;
        if (kb._keyboardVisible && !kb.get_transition('translation-y'))
            kb.translation_y = -(g.h + g.bottom);
    }

    _update(patch, kb) {
        this._state = {...this._geometry(), ...patch};
        this._state = this._geometry(); // clamp
        this._apply(kb);
    }

    _decorate(kb) {
        if (kb._tfHeader)
            return;
        kb.add_style_class_name('tf-floating');

        const header = new St.BoxLayout({style_class: 'tf-osk-header', x_expand: true, reactive: true});
        const gripL = new St.Widget({style_class: 'tf-osk-grip tf-osk-grip-left', reactive: true, track_hover: true});
        const handle = new St.Widget({
            style_class: 'tf-osk-handle-area', reactive: true, track_hover: true, x_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        handle.add_child(new St.Widget({
            style_class: 'tf-osk-handle',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const gripR = new St.Widget({style_class: 'tf-osk-grip tf-osk-grip-right', reactive: true, track_hover: true});
        header.add_child(gripL);
        header.add_child(handle);
        header.add_child(gripR);
        kb.insert_child_at_index(header, 0);
        kb._tfHeader = header;

        let start = null;
        const begin = actor => () => {
            start = this._geometry();
            kb._tfDragging = true;
            actor.add_style_pseudo_class('active');
        };
        const done = actor => () => {
            kb._tfDragging = false;
            actor.remove_style_pseudo_class('active');
            saveState(this._state ?? this._geometry());
        };

        attachDrag(handle, {
            start: begin(handle),
            move: (dx, dy) => this._update({x: start.x + dx, bottom: start.bottom - dy}, kb),
            end: done(handle),
        });
        attachDrag(gripL, {
            start: begin(gripL),
            move: (dx, dy) => {
                const w = Math.max(OSK.minWidth, start.w - dx);
                this._update({w, x: start.x + start.w - w, h: start.h - dy}, kb);
            },
            end: done(gripL),
        });
        attachDrag(gripR, {
            start: begin(gripR),
            move: (dx, dy) => this._update({w: start.w + dx, h: start.h - dy}, kb),
            end: done(gripR),
        });
    }
}
