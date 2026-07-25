#!/usr/bin/env python3
"""PDF/EPUB -> JSON chunks with page-accurate metadata.

Usage:  ingest.py BOOK.pdf [--page-offset N] > chunks.json
        ingest.py --selfcheck

Stdout is JSON only; diagnostics go to stderr.
"""
import json, os, re, sys

# ~4 chars/token. Overridable because chunk size is the single biggest retrieval lever
# and the right value is an eval result, not a guess. See eval/.
CHUNK_CHARS = int(os.environ.get("GURU_CHUNK_CHARS", 2000))
OVERLAP_CHARS = CHUNK_CHARS // 10


def parse_args(argv):
    path, offset = None, 0
    it = iter(argv)
    for a in it:
        if a == "--page-offset":
            offset = int(next(it))
        else:
            path = a
    return path, offset


def title_author(meta_title, meta_author, path):
    """Metadata wins, else the `Author - Title.ext` filename convention."""
    stem = os.path.splitext(os.path.basename(path))[0]
    author, title = (None, stem)
    if " - " in stem:
        author, title = stem.split(" - ", 1)
    return (meta_title or title).strip(), (meta_author or author or "Unknown").strip()


def clean(text):
    return re.sub(r"[ \t]+", " ", text).strip()


def read_pdf(path, page_offset):
    """-> (title, author, [(page_label, text)])"""
    import fitz
    doc = fitz.open(path)
    m = doc.metadata or {}
    title, author = title_author(m.get("title"), m.get("author"), path)
    # ponytail: physical page index + a manual offset knob. Front matter means printed
    # numbers drift; the knob is cheaper and more honest than guessing from the text.
    units = [(i + 1 + page_offset, clean(p.get_text()), False) for i, p in enumerate(doc)]
    return title, author, [u for u in units if u[1]]


def read_epub(path, _page_offset):
    """-> (title, author, [(locator, text)]). EPUBs have no pages: chapter + paragraph."""
    import ebooklib
    from ebooklib import epub
    from bs4 import BeautifulSoup
    book = epub.read_epub(path)
    title = (book.get_metadata("DC", "title") or [("", None)])[0][0]
    author = (book.get_metadata("DC", "creator") or [("", None)])[0][0]
    title, author = title_author(title, author, path)
    units = []
    for ch, item in enumerate(book.get_items_of_type(ebooklib.ITEM_DOCUMENT), 1):
        soup = BeautifulSoup(item.get_content(), "html.parser")
        for junk in soup.select('[id^="pg-"], [class^="pg-"]'):
            junk.decompose()          # Gutenberg wraps its header/footer boilerplate in pg-* nodes
        # Gutenberg-style books are often one giant document, so a document index is a
        # useless citation. Anchor to the nearest heading above the text: a reader can find it.
        section, para = f"ch. {ch}", 0
        for el in soup.find_all(["p", "h1", "h2", "h3", "h4"]):
            t = clean(el.get_text())
            if not t:
                continue
            heading = el.name != "p"
            if heading:
                section, para = f'"{t[:60]}"', 0
            para += 1
            units.append((f"{section}, para. {para}", t, heading))
    return title, author, units


GUTENBERG = (
    r"\*\*\* ?START OF TH[EIS] PROJECT GUTENBERG",
    r"\*\*\* ?END OF TH[EIS] PROJECT GUTENBERG|(START: )?THE FULL PROJECT GUTENBERG",
)


def strip_boilerplate(units):
    """Drop Gutenberg front matter and the license: it is not the book, and it poisons retrieval."""
    start, end = 0, len(units)
    for i, (_, t, _b) in enumerate(units):
        if re.search(GUTENBERG[0], t):
            start = i + 1
        elif re.search(GUTENBERG[1], t):
            end = i
            break
    return units[start:end] if start or end < len(units) else units


def split_oversized(label, text):
    """A single unit larger than a chunk (a dense PDF page) still has to be cut."""
    pieces, start = [], 0
    while start < len(text):
        end = min(start + CHUNK_CHARS, len(text))
        if end < len(text):                       # don't split mid-word
            brk = text.rfind(" ", start + CHUNK_CHARS // 2, end)
            if brk != -1:
                end = brk
        pieces.append((label, text[start:end].strip()))
        if end >= len(text):
            break
        start = max(end - OVERLAP_CHARS, start + 1)
    return pieces


# Verse and chapter markers as these books actually write them: "1.", "23.", "Ch. 4.",
# "CHAPTER XII". Off by default: measured on 151 cases over 14 books it changed nothing
# (recall@20 42% -> 43%, recall@5 23% -> 23%). Kept because the pattern never matched
# Meditations at all, so it is a partial test rather than a settled one.
SECTION_RE = re.compile(r"^\s*(\d{1,3}\.|Ch\.\s*\d+|CHAPTER\b|Chapter\b)")
SECTION_SPLIT = os.environ.get("GURU_SECTION_SPLIT") == "1"


def mark_sections(units):
    """Mark verse starts as soft boundaries: a chunk may begin there, but need not end there.

    Flushing at every verse gives ~190-char chunks, and small chunks measurably cost recall.
    A soft boundary only ends the current chunk once it is already worth keeping.
    """
    return [
        (label, text, boundary or ("soft" if SECTION_RE.match(text) else False))
        for label, text, boundary in units
    ]


def chunk(units):
    """Pack whole units up to CHUNK_CHARS; a heading always starts a new chunk.

    Slicing a flat character stream instead welds the title page and table of contents
    onto chapter one, which buries the passage a reader asked for and makes its citation
    point at the front matter.
    """
    out, buf, size = [], [], 0

    def flush(overlap=True):
        nonlocal buf, size
        if not buf:
            return
        body = "\n".join(t for _, t in buf).strip()
        if body:
            out.append({"chunk_id": len(out), "text": body,
                        "page_start": buf[0][0], "page_end": buf[-1][0]})
        # Carry the last unit forward as overlap, but never across a semantic break.
        tail = buf[-1] if overlap and len(buf) > 1 and len(buf[-1][1]) <= OVERLAP_CHARS else None
        buf = [tail] if tail else []
        size = len(tail[1]) if tail else 0

    for label, text, boundary in units:
        if boundary is True:
            flush(overlap=False)
        elif boundary == "soft" and size >= CHUNK_CHARS // 2:
            flush(overlap=False)
        parts = [(label, text)] if len(text) <= CHUNK_CHARS else split_oversized(label, text)
        for part in parts:
            if size and size + len(part[1]) > CHUNK_CHARS:
                flush()
            buf.append(part)
            size += len(part[1]) + 1
    flush(overlap=False)
    return out


def ingest(path, page_offset=0):
    reader = read_epub if path.lower().endswith(".epub") else read_pdf
    title, author, units = reader(path, page_offset)
    units = strip_boilerplate(units)
    if SECTION_SPLIT:
        units = mark_sections(units)
    if not units:
        raise SystemExit(f"no extractable text in {path} (scanned? OCR not supported yet)")
    return {"title": title, "author": author, "source": os.path.basename(path),
            "paginated": reader is read_pdf, "chunks": chunk(units)}


def sample_pdf(path=None):
    """A tiny known-content book, so every layer above can test page fidelity."""
    import fitz, tempfile
    doc = fitz.open()
    for i in range(1, 4):
        page = doc.new_page()
        page.insert_textbox(fitz.Rect(72, 72, 540, 720), f"Page {i}. " + f"filler{i} " * 400)
    page = doc.new_page()
    page.insert_textbox(fitz.Rect(72, 72, 540, 720),
                        "The needle is here on the last page. "
                        "Yoga is the stilling of the fluctuations of the mind.")
    path = path or os.path.join(tempfile.mkdtemp(), "Patanjali - Yoga Sutras.pdf")
    doc.save(path)
    return path


def selfcheck():
    path = sample_pdf()
    r = ingest(path)
    assert r["author"] == "Patanjali" and r["title"] == "Yoga Sutras", r
    assert len(r["chunks"]) > 3, "expected several chunks"
    hit = [c for c in r["chunks"] if "needle is here" in c["text"]]
    assert hit and all(c["page_start"] <= 4 <= c["page_end"] for c in hit), hit
    assert [c["chunk_id"] for c in r["chunks"]] == list(range(len(r["chunks"])))
    assert all(c["page_start"] <= c["page_end"] for c in r["chunks"])
    joined = " ".join(c["text"] for c in r["chunks"])
    assert all(f"Page {i}." in joined for i in (1, 2, 3)), "lost a page"
    assert ingest(path, page_offset=10)["chunks"][0]["page_start"] == 11, "offset knob broken"
    print("selfcheck ok:", len(r["chunks"]), "chunks", file=sys.stderr)


if __name__ == "__main__":
    if "--selfcheck" in sys.argv:
        selfcheck()
    elif "--sample" in sys.argv:
        print(sample_pdf(sys.argv[sys.argv.index("--sample") + 1]))
    else:
        path, offset = parse_args(sys.argv[1:])
        if not path:
            raise SystemExit(__doc__)
        json.dump(ingest(path, offset), sys.stdout, ensure_ascii=False)
