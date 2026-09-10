import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer } from "/pdfjs/build/pdf.mjs";

GlobalWorkerOptions.workerSrc = "/pdfjs/build/pdf.worker.mjs";
const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const reference = new URLSearchParams({ book: query.get("book") || "", revision: query.get("revision") || "" });
const url = "/source.pdf?" + reference;
const controllers = new Set();
let transferred = 0, meta, pdf, loading, rendering, textLayer, activePage, sequence = 0;
let pageNumber = 1, zoom = 1, rotation = 0;
let disposed = false;
const bookmarkKey = document.body.dataset.history + ":" + document.body.dataset.reader + ":pages";
const bytes = (n) => n < 1048576 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const savedPages = () => { try { const rows = JSON.parse(localStorage.getItem(bookmarkKey) || "[]"); return Array.isArray(rows) ? rows.filter((p) => p && typeof p.book === "string" && typeof p.revision === "string" && Number.isInteger(p.page) && p.page > 0) : []; } catch { return []; } };
function status(message, error = false) { $("status").textContent = message; $("status").classList.toggle("error", error); }

async function range(begin, end) {
  if (disposed) throw new DOMException("Reader closed", "AbortError");
  const controller = new AbortController();
  controllers.add(controller);
  try {
    const response = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal: controller.signal, cache: "no-store" });
    if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${begin}-${end - 1}/${meta.bytes}`) {
      throw new Error(response.status === 410 ? "This source has changed. Return to the library and search again." : "The PDF could not be loaded. Reload to try again.");
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== end - begin) throw new Error("The PDF transfer was interrupted. Reload to try again.");
    transferred += data.length;
    return data;
  } finally { controllers.delete(controller); }
}

class Ranges extends PDFDataRangeTransport {
  requestDataRange(begin, end) {
    range(begin, end).then((data) => { if (!disposed) this.onDataRange(begin, data); }).catch((error) => {
      if (!disposed) { status(error.message, true); loading?.destroy().catch(() => {}); }
    });
  }
  abort() { for (const controller of controllers) controller.abort(); }
}

function updateBookmarks() {
  const selected = savedPages().filter((p) => p.book === reference.get("book") && p.revision === reference.get("revision"));
  $("bookmark").setAttribute("aria-pressed", String(selected.some((p) => p.page === pageNumber)));
  $("bookmark").textContent = selected.some((p) => p.page === pageNumber) ? "Page bookmarked" : "Bookmark page";
  $("bookmarks").replaceChildren();
  for (const saved of selected.sort((a, b) => a.page - b.page)) {
    const button = document.createElement("button");
    button.textContent = `PDF page ${saved.page}`;
    button.onclick = () => go(saved.page);
    $("bookmarks").append(button);
  }
  if (!selected.length) $("bookmarks").textContent = "No saved pages in this edition yet.";
}

function findText() {
  const term = $("find").value.trim().toLowerCase();
  let count = 0;
  for (const span of $("text").querySelectorAll("span")) {
    const matches = !!term && span.textContent.toLowerCase().includes(term);
    span.classList.toggle("reader-match", matches);
    if (matches) count++;
  }
  $("matches").textContent = term ? `${count} matching text fragments on this page.` : "";
}

async function draw() {
  if (!pdf || disposed) return;
  const current = ++sequence;
  if (rendering) { rendering.cancel(); try { await rendering.promise; } catch {} }
  if (current !== sequence || disposed) return;
  textLayer?.cancel();
  activePage?.cleanup();
  status(`Opening PDF page ${pageNumber}...`);
  $("sheet").setAttribute("aria-busy", "true");
  try {
    const page = await pdf.getPage(pageNumber);
    if (current !== sequence || disposed) return;
    activePage = page;
    const pageRotation = (page.rotate + rotation) % 360;
    const natural = page.getViewport({ scale: 1, rotation: pageRotation });
    const scale = Math.max(.1, ($("viewport").clientWidth - 8) / natural.width) * zoom;
    const viewport = page.getViewport({ scale, rotation: pageRotation });
    const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16000000 / (viewport.width * viewport.height)));
    const canvas = $("canvas");
    canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
    canvas.style.width = viewport.width + "px"; canvas.style.height = viewport.height + "px";
    $("sheet").style.width = viewport.width + "px"; $("sheet").style.height = viewport.height + "px";
    $("sheet").style.setProperty("--total-scale-factor", scale);
    $("text").replaceChildren();
    rendering = page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    await rendering.promise;
    if (current !== sequence || disposed) return;
    const content = await page.getTextContent();
    if (current !== sequence || disposed) return;
    textLayer = new TextLayer({ textContentSource: content, container: $("text"), viewport });
    await textLayer.render();
    $("transcript").textContent = content.items.map((item) => item.str + (item.hasEOL ? "\n" : " ")).join("").trim() || "This page contains no selectable text. The original scanned page is shown above.";
    $("page-note").textContent = `PDF page ${pageNumber} of ${pdf.numPages}` + (meta.page_offset ? `. Printed page ${pageNumber + meta.page_offset}.` : ".");
    const flagged = meta.extraction_quality ? JSON.parse(meta.extraction_quality).flaggedPages?.find((p) => p.pdfPage === pageNumber) : undefined;
    status(`${bytes(transferred)} of ${bytes(meta.bytes)} fetched. Original PDF.` + (flagged ? " Extraction check flagged this page. Its searchable text may be incomplete." : ""));
    findText();
  } catch (error) {
    if (current === sequence && error.name !== "RenderingCancelledException" && !disposed) status(error.message || "This page could not be displayed.", true);
  } finally { if (current === sequence) $("sheet").setAttribute("aria-busy", "false"); }
}

function go(page) {
  if (!pdf || !Number.isInteger(page) || page < 1 || page > pdf.numPages) return;
  pageNumber = page;
  $("page").value = page;
  $("previous").disabled = page === 1;
  $("next").disabled = page === pdf.numPages;
  const link = new URL(location.href);
  link.searchParams.delete("pdfPage");
  link.searchParams.set("page", String(page + meta.page_offset));
  history.replaceState(null, "", link);
  updateBookmarks();
  draw();
}

$("previous").onclick = () => go(pageNumber - 1);
$("next").onclick = () => go(pageNumber + 1);
$("jump").onsubmit = (event) => { event.preventDefault(); go(Number($("page").value)); };
$("zoom-in").onclick = () => { zoom = Math.min(3, zoom + .25); draw(); };
$("zoom-out").onclick = () => { zoom = Math.max(.5, zoom - .25); draw(); };
$("fit").onclick = () => { zoom = 1; draw(); };
$("rotate").onclick = () => { rotation = (rotation + 90) % 360; draw(); };
$("find").oninput = findText;
$("bookmark").onclick = () => {
  const pages = savedPages();
  const same = (p) => p.book === reference.get("book") && p.revision === reference.get("revision") && p.page === pageNumber;
  const next = pages.some(same) ? pages.filter((p) => !same(p)) : [...pages, { book: reference.get("book"), revision: reference.get("revision"), page: pageNumber, title: meta.title }];
  try { localStorage.setItem(bookmarkKey, JSON.stringify(next.slice(-500))); updateBookmarks(); }
  catch { status("This browser could not save the bookmark.", true); }
};
document.addEventListener("keydown", (event) => {
  if (/INPUT|TEXTAREA|BUTTON/.test(event.target.tagName) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "ArrowLeft") { event.preventDefault(); go(pageNumber - 1); }
  if (event.key === "ArrowRight") { event.preventDefault(); go(pageNumber + 1); }
});
let resized;
window.addEventListener("resize", () => { clearTimeout(resized); resized = setTimeout(draw, 150); });
window.addEventListener("pagehide", () => { disposed = true; rendering?.cancel(); textLayer?.cancel(); loading?.destroy().catch(() => {}); for (const controller of controllers) controller.abort(); });

window.addEventListener("pageshow", (event) => { if (event.persisted && disposed) location.reload(); });

try {
  const metadataController = new AbortController();
  controllers.add(metadataController);
  const response = await fetch("/pdf-meta?" + reference, { cache: "no-store", signal: metadataController.signal });
  meta = await response.json();
  controllers.delete(metadataController);
  if (disposed) throw new DOMException("Reader closed", "AbortError");
  if (!response.ok || !meta.available) throw new Error(meta.error || "The original PDF is not stored for this edition.");
  $("title").textContent = meta.title; $("author").textContent = meta.author;
  document.title = meta.title + " | Source reader";
  $("download").href = url;
  const initial = await range(0, Math.min(65536, meta.bytes));
  if (disposed) throw new DOMException("Reader closed", "AbortError");
  const transport = new Ranges(meta.bytes, initial, true);
  loading = getDocument({ range: transport, length: meta.bytes, disableAutoFetch: true, disableStream: true, rangeChunkSize: 65536,
    isEvalSupported: false, enableXfa: false, cMapUrl: "/pdfjs/cmaps/", standardFontDataUrl: "/pdfjs/standard_fonts/", wasmUrl: "/pdfjs/wasm/" });
  loading.onPassword = (update) => {
    $("password-form").hidden = false;
    $("password-form").onsubmit = (event) => { event.preventDefault(); update($("password").value); $("password").value = ""; $("password-form").hidden = true; };
    $("password").focus();
  };
  pdf = await loading.promise;
  if (disposed) throw new DOMException("Reader closed", "AbortError");
  $("total").textContent = "/ " + pdf.numPages;
  $("page").max = pdf.numPages;
  for (const id of ["zoom-in", "zoom-out", "fit", "rotate", "bookmark"]) $(id).disabled = false;
  const requested = query.has("pdfPage") ? Number(query.get("pdfPage")) : Number(query.get("page")) - meta.page_offset;
  go(Number.isInteger(requested) && requested >= 1 && requested <= pdf.numPages ? requested : 1);
  let outlineLoaded = false;
  const loadOutline = async () => {
    if (!$("contents").open || outlineLoaded) return;
    outlineLoaded = true;
    try {
      const outline = await pdf.getOutline();
      if (!outline?.length) { $("outline").textContent = "This PDF has no embedded contents. Use the page controls to browse."; return; }
      const add = (items, depth = 0) => {
        for (const item of items) {
          if (item.dest) {
            const button = document.createElement("button"); button.textContent = item.title;
            button.style.paddingLeft = (12 + Math.min(depth, 5) * 10) + "px";
            button.onclick = async () => {
              try {
                const dest = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest;
                if (dest) go(typeof dest[0] === "number" ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1);
              } catch { status("This contents entry could not be opened.", true); }
            };
            $("outline").append(button);
          }
          if (item.items?.length) add(item.items, depth + 1);
        }
      };
      add(outline);
    } catch { $("outline").textContent = "Contents could not be loaded."; }
  };
  $("contents").addEventListener("toggle", loadOutline);
  if ($("contents").open) loadOutline();
} catch (error) { if (!disposed) status(error.message || "The PDF could not be opened.", true); }
