# PII Spy

A Manifest V3 Chrome extension that checks pasted text for personal information **on your device** before it reaches ChatGPT or Claude. It intercepts Ctrl+V, Cmd+V, and context-menu Paste in supported text editors.

When personal information is detected, choose which items to replace with labels such as `[EMAIL]`, preview the result, and select **Redact & Paste**, **Paste Original**, or **Cancel**. Text with no detections is inserted after the scan. Scanning errors leave the paste blocked and offer an explicit choice to paste the original or cancel.

Built from a specification by **Gemini Argon** and implemented by **ChatGPT App (GPT-6.1 Sol Ultra)**.

## Install locally

Requires Node.js 22 or newer, npm, and Chrome 116 or newer. Run commands from this directory, which contains `package.json`.

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run setup:model
npm run build
```

The model setup downloads approximately 192 MB of pinned, integrity-checked model and tokenizer files into `assets/models/pii/`. The build packages them with the JavaScript, WebAssembly runtime, and styles in `dist/`. Keep these assets local: the installed extension does not download code or model files at runtime. The build refuses to produce a normal install without verified model assets.

`--legacy-peer-deps` avoids GLiNER's unused Node runtime peer; the extension uses the pinned browser WebAssembly runtime. `--ignore-scripts` disables dependency installation hooks.

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this project's **`dist`** directory.
4. Pin PII Spy from Chrome's Extensions menu.
5. Open its popup and choose **Prepare detector**. The initial model load takes longer than later scans.
6. Choose **Try the local test editor** to test without sharing text with a website.
7. Reload any ChatGPT or Claude tabs opened before installation, then paste into an editor.

After changing source code, run `npm run build`, click **Reload** on the extension card, and reload the website tabs. The extension popup includes a switch to disable or re-enable protection.

## Try it

Copy this fictional example into the local test editor:

```text
Contact Alex Morgan at alex.morgan@example.com or +61 412 345 678.
```

The editor stays unchanged while the scan runs. Review the detected items and the redacted preview, then choose an action. Also try a sentence without personal information, replacing an existing text selection, and pasting into the single-line and rich-text editors.

## Privacy and behavior

- Clipboard access comes from the user's paste event. There is no background clipboard monitoring and no `clipboardRead` permission.
- Clipboard text and detections are never persisted, logged, or sent to a remote service. Only the protection preference is stored locally.
- Model inference runs in a shared offscreen extension document, isolated from the target site's Content Security Policy. Model files and WebAssembly are not exposed as web-accessible resources.
- The original paste is stopped synchronously, before asynchronous scanning starts. Approved text is inserted at the saved selection. All insertion is plain text, so clipboard HTML cannot carry hidden unredacted data.
- If the destination changes, becomes read-only, or disappears during scanning, PII Spy refuses to overwrite it. Paste again at the intended position.
- A second paste while a review is active is blocked. Finish or cancel the current paste first.
- Scans are limited to 50,000 JavaScript UTF-16 code units per paste. Large pastes and scanner failures require the user's explicit decision; they never silently pass as clean.

Detection combines GLiNER with structured checks for common patterns such as email addresses, phone numbers, payment cards, IP addresses, and credentials. Model predictions can miss information or flag ordinary text; review the result before sharing sensitive data. This extension covers text pastes into supported editors on the configured sites. File uploads, images, typing, drag and drop, and other ways of submitting data are outside its scope. Pasting into rich-text editors converts the approved payload to plain text.

The bundled INT8 model is [`onnx-community/gliner_small-v2.1`](https://huggingface.co/onnx-community/gliner_small-v2.1/tree/8142fb00740ccea973e64b1272949ff48653df5e), revision `8142fb00740ccea973e64b1272949ff48653df5e`, one of the spec's alternatives. The `knowledgator/gliner-pii-small-v1.0` suggestion uses a ModernBERT tokenizer incompatible with the published `gliner@0.0.19` implementation's assumed special-token IDs. The selected DeBERTa model matches the library. Asset checksums and sizes are recorded in `scripts/model-config.js`.

## Development and tests

```sh
npm test
npx playwright install chromium --no-shell
npm run test:browser
npm run test:extension
npm run check:dependencies
```

Run `npm run build` before browser tests. Unit tests cover routing, offscreen initialization, validation, detection offsets, redaction, popup settings, and editor behavior. `test:browser` exercises the built content script with a controlled scan transport; it uses local Chrome on macOS or the installed Playwright Chromium. Override that executable with `CHROME_PATH` if needed.

`test:extension` loads the actual packaged extension and runs its local ONNX model, including contextual name detection, the review dialog, redacted insertion, a protected-site fixture with a restrictive CSP, and a check for remote requests. It requires Playwright Chromium because branded Chrome can restrict loading extensions through command-line flags. Set `PII_SPY_CHROMIUM_PATH` to use a custom Chromium executable. Both browser suites use fictional data and controlled pages; they do not send text to ChatGPT or Claude.

The code is JavaScript throughout. Dependencies are pinned in `package-lock.json`, with a minimum three-day cooling period when updating dependencies. Pico CSS supplies the base UI styles and is bundled locally; no CDN is used.

```text
public/                 Manifest, extension pages, popup styles, local demo
src/background.js       Service worker entry point
src/background-controller.js
                        Offscreen lifecycle, sender checks, message routing
src/content/            Paste capture, selection snapshots, review UI, insertion
src/offscreen/          Shared local GLiNER inference
src/shared/             Structured detection and offset handling
scripts/                Build, dependency checks, pinned model setup
tests/                  Unit and browser verification
assets/models/pii/      Downloaded model assets (ignored by Git)
dist/                   Load this generated directory in Chrome (ignored by Git)
```

The message route is content script → background service worker → offscreen document → background → content script. The offscreen model is initialized once, shared across tabs, and scans are serialized to avoid inference-state races. The content script blocks first, then waits; it never awaits inference before calling `preventDefault()`.

The supported sites are declared in `public/manifest.json` and checked by `canScan` in `src/background-controller.js`. To add a site, update both, add a browser test for its editor, rebuild, and reload. This project deliberately omits the spec's placeholder `your-target-site.com` match.

## Troubleshooting

- **Detector unavailable:** run `npm run setup:model` and `npm run build`, reload the extension, then choose **Prepare detector** again. Keep the complete `dist/` directory together.
- **No interception:** confirm protection is on, reload the website tab after loading the extension, and check that the URL is `https://chatgpt.com/` or `https://claude.ai/`.
- **Editor changed or unsupported:** cancel and paste again. Editors without a supported text selection cannot receive an automatic insertion.
- **Slow first scan:** prepare the model in the popup before pasting. Later scans reuse it while the offscreen document remains alive.

Implementation follows Chrome's [offscreen document API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) and [Manifest V3 CSP requirements](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy). The product specification is in [`specs/spec1.md`](specs/spec1.md); project conventions are in [`agents.md`](agents.md).
