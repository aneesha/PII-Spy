import picoCss from '@picocss/pico/css/pico.min.css';
import { createPasteGuard } from './guard.js';

createPasteGuard({ window, chrome, css: picoCss });
