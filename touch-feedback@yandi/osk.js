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

// Ikuti satu sentuhan/klik yang dimulai di actor sampai jari/tombol dilepas.
// Gerakan & lepasnya dibaca di level stage (bukan dari actor), karena jari
// sering keluar dari pegangan yang kecil; kalau "lepas" nggak ketangkep,
// sentuhan berikutnya (nomor slot sering sama) bakal dikira masih resize.
// Sengaja tanpa global.stage.grab(): grab bikin aplikasi kehilangan fokus
// ketik, lalu GNOME langsung nurunin keyboard.
function attachDrag(actor, {start, move, end}) {
    const T = Clutter.EventType;
    let drag = null; // {slot, x, y, stageId}

    const finish = () => {
        if (!drag)
            return;
        global.stage.disconnect(drag.stageId);
        drag = null;
        end();
    };

    actor.connect('event', (_a, event) => {
        const type = event.type();
        if (type !== T.TOUCH_BEGIN && type !== T.BUTTON_PRESS)
            return Clutter.EVENT_PROPAGATE;
        finish();
        const touch = type === T.TOUCH_BEGIN;
        const slot = touch ? event.get_event_sequence()?.get_slot() ?? 0 : null;
        const [x, y] = event.get_coords();
        const stageId = global.stage.connect('captured-event', (_s, ev) => {
            const t = ev.type();
            const evTouch = t === T.TOUCH_UPDATE || t === T.TOUCH_END || t === T.TOUCH_CANCEL;
            if (touch) {
                if (!evTouch || (ev.get_event_sequence()?.get_slot() ?? 0) !== slot)
                    return Clutter.EVENT_PROPAGATE;
            } else if (t !== T.MOTION && t !== T.BUTTON_RELEASE) {
                return Clutter.EVENT_PROPAGATE;
            }
            if (t === T.TOUCH_UPDATE || t === T.MOTION) {
                const [cx, cy] = ev.get_coords();
                move(cx - drag.x, cy - drag.y);
            } else {
                finish();
            }
            return Clutter.EVENT_STOP;
        });
        drag = {slot, x, y, stageId};
        start();
        return Clutter.EVENT_STOP;
    });
    actor.connect('destroy', finish);
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
            kb._tfFooter?.destroy();
            kb._tfHeader = kb._tfFooter = null;
            kb.remove_style_class_name('tf-floating');
            kb.x_align = Clutter.ActorAlign.FILL;
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
        // Anak yang x_expand bikin keyboard ikut "expand" lalu ditarik selebar
        // keyboardBox (selebar layar) tiap relayout, mis. waktu ngetik.
        // Set eksplisit supaya ukuran pilihan user yang dipakai.
        kb.x_expand = false;
        kb.y_expand = false;
        kb.x_align = Clutter.ActorAlign.START;

        const header = new St.BoxLayout({style_class: 'tf-osk-header', x_expand: true, reactive: true});
        const handle = new St.Widget({
            style_class: 'tf-osk-handle-area', reactive: true, track_hover: true, x_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        handle.add_child(new St.Widget({
            style_class: 'tf-osk-handle',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(handle);
        kb.insert_child_at_index(header, 0);

        // Pojok bawah kiri/kanan buat resize.
        const footer = new St.BoxLayout({style_class: 'tf-osk-footer', x_expand: true});
        const gripL = new St.Widget({style_class: 'tf-osk-grip tf-osk-grip-left', reactive: true, track_hover: true});
        const gripR = new St.Widget({style_class: 'tf-osk-grip tf-osk-grip-right', reactive: true, track_hover: true});
        footer.add_child(gripL);
        footer.add_child(new St.Widget({x_expand: true}));
        footer.add_child(gripR);
        kb.add_child(footer);

        kb._tfHeader = header;
        kb._tfFooter = footer;

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
        // Tarik pojok bawah: tepi atas tetap, tepi bawah ikut jari.
        const resizeBottom = dy => {
            let h = Math.max(OSK.minHeight, start.h + dy);
            let bottom = start.bottom - (h - start.h);
            if (bottom < 0) {
                h += bottom;
                bottom = 0;
            }
            return {h, bottom};
        };
        attachDrag(gripL, {
            start: begin(gripL),
            move: (dx, dy) => {
                const w = Math.max(OSK.minWidth, start.w - dx);
                this._update({w, x: start.x + start.w - w, ...resizeBottom(dy)}, kb);
            },
            end: done(gripL),
        });
        attachDrag(gripR, {
            start: begin(gripR),
            move: (dx, dy) => this._update({w: Math.max(OSK.minWidth, start.w + dx), ...resizeBottom(dy)}, kb),
            end: done(gripR),
        });
    }
}
