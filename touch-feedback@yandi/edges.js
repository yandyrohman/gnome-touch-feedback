import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as KeyboardUI from 'resource:///org/gnome/shell/ui/keyboard.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {EDGES} from './config.js';

const DOCK_UUID = 'ubuntu-dock@ubuntu.com';

// Swipe dari bezel bawah: zona tengah -> dock, kiri/kanan -> keyboard layar.
export class EdgeGestures {
    enable() {
        this._gestures = [];
        this._lastBegin = null;
        this._outsideId = 0;
        this._dockModule = null;

        // Lepas gesture bawaan "bawah = keyboard", kita ganti versi berzona.
        this._oskBottom = Main.keyboard._bottomDragGesture ?? null;
        if (this._oskBottom)
            global.stage.remove_action(this._oskBottom);

        // Catat titik awal sentuhan buat nentuin zona swipe.
        this._beginId = global.stage.connect('captured-event', (_a, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN)
                this._lastBegin = event.get_coords();
            return Clutter.EVENT_PROPAGATE;
        });

        const dock = this._makeGesture('Touch edges: dock', Shell.ActionMode.NORMAL, true);
        dock.connect('end', () => this._showDock());

        const osk = this._makeGesture('Touch edges: keyboard',
            Shell.ActionMode.ALL & ~Shell.ActionMode.LOCK_SCREEN, false);
        osk.connect('progress', (_g, progress) => Main.keyboard.keyboardActor?.gestureProgress(progress));
        osk.connect('end', () => {
            const kb = Main.keyboard.keyboardActor;
            if (kb) {
                Main.layoutManager.keyboardIndex = Main.layoutManager.bottomIndex;
                kb._tfAllowOpen = true;
                kb.gestureActivate();
                kb._tfAllowOpen = false;
            }
        });
        osk.connect('cancel', () => Main.keyboard.keyboardActor?.gestureCancel());

        this._loadDock();
        this._forceOskReady();
        this._onlyOpenByGesture();
    }

    // Keyboard cuma boleh muncul lewat swipe bezel, bukan otomatis tiap
    // kolom teks disentuh.
    _onlyOpenByGesture() {
        if (!EDGES.oskOnlyByGesture)
            return;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(KeyboardUI.Keyboard.prototype, 'open', original => function (...args) {
            if (!this._tfAllowOpen && !this._keyboardVisible)
                return;
            original.apply(this, args);
        });
    }

    disable() {
        this._injections?.clear();
        this._injections = null;
        this._stopOutsideWatch();
        this._restoreOsk();
        if (this._beginId) {
            global.stage.disconnect(this._beginId);
            this._beginId = 0;
        }
        for (const g of this._gestures)
            global.stage.remove_action(g);
        this._gestures = null;
        if (this._oskBottom) {
            global.stage.add_action(this._oskBottom);
            this._oskBottom = null;
        }
        this._dockModule = null;
    }

    _makeGesture(name, modes, center) {
        const g = new Shell.EdgeDragGesture({name, side: St.Side.BOTTOM});
        g.connect('may-recognize', () => {
            if ((modes & Main.actionMode) === 0)
                return false;
            if (!this._nearBottom(g))
                return false;
            return this._inCenter(g) === center;
        });
        global.stage.add_action(g);
        this._gestures.push(g);
        return g;
    }

    // Clutter.Gesture.get_point_begin_coords() ngasih angka ngaco dari GJS,
    // jadi pakai titik awal sentuhan yang kita catat sendiri.
    _begin(_g) {
        return this._lastBegin ?? null;
    }

    _monitor() {
        return Main.layoutManager.monitors[Main.layoutManager.bottomIndex] ??
            Main.layoutManager.primaryMonitor;
    }

    // Sentuhan awal harus mepet tepi bawah layar.
    _nearBottom(g) {
        const b = this._begin(g);
        const mon = this._monitor();
        if (!b || !mon)
            return true;
        return b[1] >= mon.y + mon.height - EDGES.bottomEdge;
    }

    _inCenter(g) {
        const x = this._begin(g)?.[0] ?? null;
        const mon = this._monitor();
        if (x === null || !mon)
            return true;
        const rel = (x - mon.x) / mon.width;
        const half = EDGES.centerZone / 2;
        return rel >= 0.5 - half && rel <= 0.5 + half;
    }

    // GNOME cuma nyiapin keyboard layar di "touch mode" (mode tablet). Laptop
    // non-convertible nggak pernah masuk mode itu, jadi kita anggap selalu touch
    // mode: keyboard disiapin begitu input terakhir dari layar sentuh.
    _forceOskReady() {
        const kbm = Main.keyboard;
        if (!kbm?._seat || this._origSeat)
            return;
        this._origSeat = kbm._seat;
        kbm._seat = {get_touch_mode: () => true};
        kbm._syncEnabled();
    }

    _restoreOsk() {
        if (!this._origSeat)
            return;
        Main.keyboard._seat = this._origSeat;
        this._origSeat = null;
        Main.keyboard._syncEnabled();
    }

    async _loadDock() {
        try {
            const ext = Main.extensionManager.lookup(DOCK_UUID);
            if (!ext)
                return;
            const mod = await import(ext.dir.get_child('extension.js').get_uri());
            if (this._gestures)
                this._dockModule = mod;
        } catch (e) {
            console.warn(`touch-feedback: dock nggak bisa diakses: ${e}`);
        }
    }

    _dock() {
        const mgr = this._dockModule?.dockManager;
        if (!mgr)
            return null;
        return mgr.getDockByMonitor?.(Main.layoutManager.bottomIndex) ?? mgr.mainDock ?? null;
    }

    _showDock() {
        const dock = this._dock();
        if (!dock)
            return;
        dock._show();
        this._stopOutsideWatch();
        // Tap di luar dock -> dock balik ngumpet (ikut aturan autohide/intellihide).
        this._outsideId = global.stage.connect('captured-event', (_a, event) => {
            const t = event.type();
            if (t !== Clutter.EventType.TOUCH_BEGIN && t !== Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            const [bx, by] = dock._box.get_transformed_position();
            const [bw, bh] = dock._box.get_transformed_size();
            if (x < bx || x > bx + bw || y < by || y > by + bh) {
                this._stopOutsideWatch();
                dock._updateDashVisibility();
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _stopOutsideWatch() {
        if (this._outsideId) {
            global.stage.disconnect(this._outsideId);
            this._outsideId = 0;
        }
    }
}
