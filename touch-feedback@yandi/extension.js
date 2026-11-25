import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {TouchEffects} from './brush.js';
import {EdgeGestures} from './edges.js';
import {FloatingKeyboard} from './osk.js';

export default class TouchFeedbackExtension extends Extension {
    enable() {
        this._parts = [
            new TouchEffects(this.path),
            new EdgeGestures(),
            new FloatingKeyboard(),
        ];
        for (const p of this._parts)
            p.enable();
    }

    disable() {
        for (const p of this._parts.reverse())
            p.disable();
        this._parts = null;
    }
}
