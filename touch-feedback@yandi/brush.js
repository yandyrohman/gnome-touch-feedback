import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TAP, BRUSH, SOUND} from './config.js';

const PAD = 4; // ruang ekstra di sekitar kuas

// Satu goresan kuas: kanvas kecil seukuran goresan yang digambar ulang tiap frame.
class Stroke {
    constructor(onDone) {
        this._points = [];
        this._live = true;
        this._onDone = onDone;
        this._area = new St.DrawingArea({reactive: false});
        this._area.connect('repaint', () => this._paint());
        Main.layoutManager.uiGroup.add_child(this._area);
        this._timeline = new Clutter.Timeline({actor: this._area, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this._timeline.start();
    }

    add(x, y) {
        const now = GLib.get_monotonic_time() / 1000;
        const last = this._points.at(-1);
        if (last && Math.hypot(x - last.x, y - last.y) < 2) {
            last.t = now;
            return;
        }
        this._points.push({x, y, t: now});
    }

    release() {
        this._live = false;
    }

    destroy() {
        this._timeline?.stop();
        this._timeline = null;
        this._area?.destroy();
        this._area = null;
    }

    _tick() {
        const now = GLib.get_monotonic_time() / 1000;
        // Ekor: buang titik yang sudah lewat umurnya, sisakan yang terbaru kalau jari masih nempel.
        while (this._points.length > (this._live ? 1 : 0) && now - this._points[0].t > BRUSH.tail)
            this._points.shift();
        if (!this._live && this._points.length === 0) {
            this.destroy();
            this._onDone(this);
            return;
        }
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const p of this._points) {
            x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
            x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
        }
        const m = BRUSH.width + PAD;
        this._ox = Math.floor(x1 - m);
        this._oy = Math.floor(y1 - m);
        this._area.set_position(this._ox, this._oy);
        this._area.set_size(Math.ceil(x2 - x1 + 2 * m), Math.ceil(y2 - y1 + 2 * m));
        this._now = now;
        this._area.queue_repaint();
    }

    _paint() {
        const cr = this._area.get_context();
        const ribbon = this._ribbon();
        if (ribbon) {
            // Digambar opaque dalam satu group lalu dipudarkan sekaligus:
            // nggak ada bagian yang numpuk jadi titik-titik.
            for (const [rgba, grow] of [[BRUSH.shadow, 1.5], [BRUSH.color, 0]]) {
                cr.pushGroup();
                cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], 1);
                this._fillRibbon(cr, ribbon, grow);
                cr.popGroupToSource();
                cr.paintWithAlpha(rgba[3]);
            }
        }
        cr.$dispose();
    }

    // Titik dihaluskan (Chaikin), tiap titik dapat setengah lebar kuas:
    // tebal di dekat jari, menipis ke ekor sesuai umur.
    _ribbon() {
        let pts = this._points.map(p => ({x: p.x - this._ox, y: p.y - this._oy, t: p.t}));
        if (pts.length < 2)
            return null;
        for (let k = 0; k < 2 && pts.length > 2; k++) {
            const out = [pts[0]];
            for (let i = 0; i < pts.length - 1; i++) {
                const a = pts[i], b = pts[i + 1];
                out.push({x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y, t: 0.75 * a.t + 0.25 * b.t});
                out.push({x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y, t: 0.25 * a.t + 0.75 * b.t});
            }
            out.push(pts.at(-1));
            pts = out;
        }
        const n = pts.length;
        return pts.map((p, i) => {
            const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
            let tx = next.x - prev.x, ty = next.y - prev.y;
            const len = Math.hypot(tx, ty) || 1;
            tx /= len; ty /= len;
            const life = Math.max(0, 1 - (this._now - p.t) / BRUSH.tail);
            const pos = i / (n - 1);
            const hw = BRUSH.width / 2 * Math.pow(life, 0.7) * (0.15 + 0.85 * pos);
            return {x: p.x, y: p.y, nx: -ty, ny: tx, hw};
        });
    }

    _fillRibbon(cr, r, grow) {
        cr.moveTo(r[0].x + r[0].nx * (r[0].hw + grow), r[0].y + r[0].ny * (r[0].hw + grow));
        for (const p of r)
            cr.lineTo(p.x + p.nx * (p.hw + grow), p.y + p.ny * (p.hw + grow));
        for (let i = r.length - 1; i >= 0; i--)
            cr.lineTo(r[i].x - r[i].nx * (r[i].hw + grow), r[i].y - r[i].ny * (r[i].hw + grow));
        cr.closePath();
        cr.fill();
        const head = r.at(-1);
        cr.arc(head.x, head.y, head.hw + grow, 0, 2 * Math.PI);
        cr.fill();
    }
}

export class TouchEffects {
    constructor(path) {
        this._tapSound = Gio.File.new_for_path(`${path}/click.wav`);
    }

    enable() {
        this._lastSound = 0;
        this._actors = new Set();
        this._strokes = new Set();
        this._touches = new Map();
        this._eventId = global.stage.connect('captured-event', (_a, event) => {
            this._onEvent(event);
            return Clutter.EVENT_PROPAGATE;
        });
    }

    disable() {
        if (this._eventId) {
            global.stage.disconnect(this._eventId);
            this._eventId = 0;
        }
        for (const a of this._actors)
            a.destroy();
        for (const s of this._strokes)
            s.destroy();
        this._actors = this._strokes = this._touches = null;
    }

    _onEvent(event) {
        const T = Clutter.EventType;
        const type = event.type();
        if (type !== T.TOUCH_BEGIN && type !== T.TOUCH_UPDATE &&
            type !== T.TOUCH_END && type !== T.TOUCH_CANCEL)
            return;
        const slot = event.get_event_sequence()?.get_slot() ?? 0;
        const [x, y] = event.get_coords();
        this.handle(type, slot, x, y);
    }

    // Dipisah dari _onEvent biar bisa dites tanpa layar sentuh.
    handle(type, slot, x, y) {
        const T = Clutter.EventType;
        if (type === T.TOUCH_BEGIN) {
            this._touches.get(slot)?.stroke?.release();
            this._touches.set(slot, {
                sx: x, sy: y, swipe: false, stroke: null,
                onKeyboard: this._onKeyboard(x, y),
                dot: this._spawnDot(x, y),
            });
            return;
        }

        const t = this._touches.get(slot);
        if (!t)
            return;

        if (type === T.TOUCH_UPDATE) {
            if (!t.swipe && Math.hypot(x - t.sx, y - t.sy) > TAP.swipeThreshold) {
                t.swipe = true;
                this._fadeOut(t.dot, 120);
                t.dot = null;
                if (!t.onKeyboard) {
                    t.stroke = new Stroke(s => this._strokes?.delete(s));
                    this._strokes.add(t.stroke);
                    t.stroke.add(t.sx, t.sy);
                }
            }
            t.stroke?.add(x, y);
            return;
        }

        this._touches.delete(slot);
        this._fadeOut(t.dot, 150);
        t.stroke?.release();
        if (type === T.TOUCH_CANCEL)
            return;

        // Swipe sengaja tanpa suara; cuma tap yang bunyi.
        if (!t.swipe) {
            this._spawnRipple(x, y);
            this._play(this._tapSound);
        }
    }

    // Geser/resize keyboard nggak perlu jejak kuas.
    _onKeyboard(x, y) {
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        return !!actor && Main.layoutManager.keyboardBox.contains(actor);
    }

    _circle(x, y, size, opacity = 255) {
        const a = new St.Widget({
            reactive: false,
            width: size,
            height: size,
            x: Math.round(x - size / 2),
            y: Math.round(y - size / 2),
            opacity,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            style: `border-radius: ${size}px; background-color: ${TAP.color}; border: 2px solid ${TAP.border};`,
        });
        Main.layoutManager.uiGroup.add_child(a);
        this._actors.add(a);
        a.connect('destroy', () => this._actors?.delete(a));
        return a;
    }

    _ease(a, props) {
        a.ease({...props, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: () => a.destroy()});
    }

    _spawnDot(x, y) {
        const a = this._circle(x, y, TAP.dotSize, 0);
        a.set_scale(0.6, 0.6);
        a.ease({scale_x: 1, scale_y: 1, opacity: 230, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        // Jaga-jaga kalau TOUCH_END nggak sampai: titik hilang sendiri.
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            a._autoHide = 0;
            this._fadeOut(a, 200);
            return GLib.SOURCE_REMOVE;
        });
        a._autoHide = id;
        a.connect('destroy', () => {
            if (a._autoHide)
                GLib.source_remove(a._autoHide);
        });
        return a;
    }

    _fadeOut(a, duration) {
        if (!a || !this._actors?.has(a))
            return;
        a.remove_all_transitions();
        this._ease(a, {opacity: 0, duration});
    }

    _spawnRipple(x, y) {
        const a = this._circle(x, y, TAP.rippleSize);
        this._ease(a, {scale_x: TAP.rippleScale, scale_y: TAP.rippleScale, opacity: 0, duration: TAP.rippleDuration});
    }

    _play(file) {
        if (!SOUND.enabled)
            return;
        const now = GLib.get_monotonic_time();
        if (now - this._lastSound < SOUND.minGapUs)
            return;
        this._lastSound = now;
        global.display.get_sound_player().play_from_file(file, 'Touch', null);
    }
}
