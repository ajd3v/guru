#!/usr/bin/env python3
"""Check stored passages against local original PDFs. Read-only. No OCR or network."""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import fitz


def flat(text):
    return re.sub(r'\s+', ' ', text).strip()


def quality(doc):
    pages = []
    for index, page in enumerate(doc):
        text = page.get_text()
        chars = len(text.strip())
        issues = []
        if chars == 0 and page.get_images():
            issues.append('image-only')
        elif chars == 0:
            issues.append('blank-or-unreadable')
        elif chars < 40:
            issues.append('sparse-text')
        if text.count('\ufffd') > max(2, chars * .01):
            issues.append('replacement-characters')
        if issues:
            pages.append({'pdfPage': index + 1, 'characters': chars, 'issues': issues})
    return {'pages': len(doc), 'flaggedPages': pages}


def inspect(db_path, files, manifest):
    db = sqlite3.connect('file:' + os.path.abspath(db_path) + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    rows = []
    entries = json.load(open(manifest))
    for raw in db.execute('select id,title,author,source,paginated from books order by id'):
        book = dict(raw)
        entry = [e for e in entries if e.get('title') == book['title'] and e.get('author') == book['author']]
        path = os.path.join(files, os.path.basename(book['source']))
        row = {'book': book, 'path': os.path.abspath(path), 'verified': False}
        rows.append(row)
        if len(entry) > 1:
            row['reason'] = 'ambiguous manifest entry'
            continue
        if not path.lower().endswith('.pdf') or not os.path.isfile(path):
            row['reason'] = 'original PDF unavailable'
            continue
        offset = entry[0].get('page_offset', 0) if entry else 0
        row['mapping'] = 'manifest offset' if entry else 'stored filename, zero offset checked against every chunk'
        row['pageOffset'] = offset
        try:
            original = open(path, "rb").read()
            with fitz.open(stream=original, filetype="pdf") as doc:
                row['quality'] = quality(doc)
                pages = [flat(p.get_text()) for p in doc]
                chunks = [dict(c) for c in db.execute('select chunk_id,text,page_start,page_end from chunks where book_id=? order by chunk_id', (book['id'],))]
                row['chunks'] = len(chunks)
                row['contentHash'] = hashlib.sha256(json.dumps(chunks, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
                failed = []
                for c in chunks:
                    try:
                        start, end = int(c['page_start']) - offset, int(c['page_end']) - offset
                    except (ValueError, TypeError):
                        failed.append({'chunk': c['chunk_id'], 'reason': 'non-numeric page'})
                        continue
                    if start < 1 or end > len(pages) or end < start:
                        failed.append({'chunk': c['chunk_id'], 'reason': 'page outside PDF'})
                    elif flat(c['text']) not in flat(' '.join(pages[start - 1:end])):
                        failed.append({'chunk': c['chunk_id'], 'reason': 'text differs at cited pages'})
                row['failures'] = failed
                row['verified'] = bool(chunks) and not failed
                row['sha256'] = hashlib.sha256(original).hexdigest()
                if not row['verified']:
                    row['reason'] = 'source verification failed'
        except Exception as error:
            row['reason'] = str(error)
    db.close()
    return {'version': 1, 'database': os.path.abspath(db_path), 'selected': len(rows), 'verified': sum(r['verified'] for r in rows), 'rows': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database')
    parser.add_argument('--files', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = inspect(args.database, args.files, args.manifest)
    with open(args.output, 'w') as out:
        json.dump(result, out, indent=2)
    print(f"Verified {result['verified']}/{result['selected']} original PDFs. Report {args.output}")
