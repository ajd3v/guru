import { basename } from "node:path";
import type Database from "better-sqlite3";
import { profile } from "./profile.ts";
import { listBooks, selectedBook, BookSelectionError, type LibraryBook } from "./store.ts";
import { sourceBook, sourceContext, type Source } from "./source.ts";

const escape = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const detailsFor = (book: { title: string; author: string; source?: string }) => {
  const matches = profile.bookDetails.filter((d) => d.title === book.title && d.author === book.author);
  return matches.find((d) => d.source && d.source === book.source) ?? matches.find((d) => !d.source);
};
export const bookLink = (book: { id: number; revision: string }) => `/book?book=${book.id}&revision=${book.revision}`;

export function selection(db: Database.Database, form: URLSearchParams) {
  const primary = selectedBook(db, form.get("book"));
  const comparisons = [...new Set(form.getAll("compare").filter(Boolean))].map((id) => selectedBook(db, id)!);
  const chosen = [...new Map([...(primary ? [primary] : []), ...comparisons].map((book) => [book.id, book])).values()];
  if (chosen.length > 4) throw new BookSelectionError("Choose at most four books to compare.");
  return { chosen, choice: { books: listBooks(db), selected: primary?.id, compare: comparisons.map((b) => b.id) } };
}

export function picker(books: LibraryBook[], compare: number[] = []) {
  const traditions = [...new Set(books.map((b) => detailsFor(b)?.tradition).filter(Boolean))];
  const editions = [...new Set(books.map((b) => detailsFor(b)?.edition).filter(Boolean))];
  const filter = (id: string, label: string, values: (string | undefined)[]) => values.length ? `<label for="${id}">${label}</label><select id="${id}"><option value="">All</option>${values.sort().map((v) => `<option>${escape(v)}</option>`).join("")}</select>` : "";
  const option = (book: LibraryBook) => {
    const d = detailsFor(book);
    const label = book.title + ", " + book.author + (books.filter((b) => b.title === book.title && b.author === book.author).length > 1 ? ` (${basename(book.source)}, ${book.id})` : "");
    return `<option value="${book.id}" data-tradition="${escape(d?.tradition || "")}" data-edition="${escape(d?.edition || "")}"${compare.includes(book.id) ? " selected" : ""}>${escape(label)}</option>`;
  };
  return `<details class="library-tools"><summary>Find a book or compare sources</summary><div class="book-filters"><label for="book-filter">Filter book titles or authors</label><input id="book-filter" type="search" placeholder="Title or author">${filter("tradition-filter", "Tradition", traditions)}${filter("edition-filter", "Edition", editions)}</div>
    <label for="compare">Compare with additional books</label><select id="compare" name="compare" form="ask-form" multiple size="5">${books.map(option).join("")}</select><p class="note">Choose up to four books in total. Each selected book is searched separately.</p><p id="book-count" class="note" role="status"></p></details>`;
}

export function browseBook(db: Database.Database, book: Source, params: URLSearchParams) {
  sourceBook(db, String(book.id), book.revision);
  const requested = params.get("chunk");
  const target = requested ? sourceContext(db, book, requested) : undefined;
  const offset = target ? Math.floor(target.chunk_id / 100) * 100 : Math.min(1000000, Math.max(0, Math.floor(Number(params.get("offset")) || 0)));
  const rows = db.prepare("select c.id, c.text, c.page_start, c.page_end from chunks c join books b on b.id = c.book_id where c.book_id = ? and b.revision = ? order by c.chunk_id limit 101 offset ?").all(book.id, book.revision, offset) as { id: number; text: string; page_start: string; page_end: string }[];
  const d = detailsFor(book);
  const heading = `<h2>${escape(book.title)}</h2><p>${escape(book.author)}</p>${d ? `<p class="note">${escape([d.tradition, d.edition].filter(Boolean).join(". "))}</p>` : ""}`;
  const pdf = book.bytes ? `<p><a href="/reader?book=${book.id}&revision=${book.revision}&page=${1 + book.page_offset}">Read original PDF</a></p>` : '<p class="note">The original PDF is not stored for this edition. Its source passages are available below.</p>';
  const links = rows.slice(0, 100).map((row) => `<li><cite><button type="button" class="source" data-book="${book.id}" data-revision="${book.revision}" data-chunk="${row.id}" data-title="${escape(book.title)}" data-page="${escape(row.page_start)}" aria-expanded="false">${escape(book.paginated ? "Page " + row.page_start : row.page_start)}. ${escape(row.text.replace(/\s+/g, " ").slice(0, 85))}</button></cite></li>`).join("");
  return `${heading}${pdf}<h3>Pages and passages</h3><ol class="book-passages">${links}</ol><nav>${offset ? `<a href="${bookLink(book)}&offset=${Math.max(0, offset - 100)}">Previous passages</a> ` : ""}${rows.length > 100 ? `<a href="${bookLink(book)}&offset=${offset + 100}">Next passages</a>` : ""}</nav>`;
}
