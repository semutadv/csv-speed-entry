// A fast single-pass CSV reader whose answers match csv-reader 1.0.0
// exactly, including its broken-row error policy. No dependencies.
//
// The reading policy run() honours:
//   * one leading U+FEFF is dropped;
//   * a record ends at LF or CRLF, and a line with no characters is no
//     record at all;
//   * a CR outside quotes that is not part of a CRLF is dropped (stray_cr);
//   * a field that opens with a quote runs to the next quote that is not
//     doubled: "" inside it is one quote, and each CRLF or lone CR inside
//     it reads as one LF; whatever follows the closing quote, up to the
//     next comma or line break, is appended as it stands (quote_junk, when
//     anything was appended); a quote that never closes is a literal
//     character and the text after it is read again as unquoted
//     (unterminated_quote);
//   * a quote inside an unquoted field is a literal character; fields are
//     never trimmed or converted;
//   * columns is the first record when header is true, else null; every
//     row is padded with "" (short_row) or cut (long_row) to the first
//     record's width;
//   * each error is {code, line, row} in the order met: line is the
//     1-based line its record starts on, counting every LF, CRLF and lone
//     CR inside quotes, and row is its record's index in rows, null for
//     the header.
//
// Speed comes from never building a field character by character: plain
// stretches of text are cut out with slice(), delimiter hunts run through
// the engine's indexOf, and a quote-free, CR-free line is split on its
// commas in one go.

// How a field ended: at a comma (the record goes on), at a line break
// (the record is done), or at the end of the text.
const MORE = 0;
const DONE = 1;
const EOF = 2;

// Shared result slot for the field scanners below. Each scanner fills it
// and its caller reads it at once, so the hot loop allocates no result
// object per field. kept counts the characters a scan appended past its
// prefix (dropped CRs and the delimiter do not count).
const slot = { value: '', end: EOF, kept: 0 };

export function run(input) {
  const text = String(input.text);
  const wantHeader = input.header === true;
  const n = text.length;

  const rows = [];
  const errors = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on, and the index it takes
  // in rows (null while it could still be the header).
  let recLine = 1;
  let recRow = null;

  // Watermarks for the whole-line fast path: the next quote and the next
  // CR in the text. pos only ever moves forward, so each watermark is
  // refreshed lazily and every indexOf scan covers new ground only.
  let nextQuote = text.indexOf('"');
  let nextCr = text.indexOf('\r');

  function noteError(code) {
    errors.push({ code, line: recLine, row: recRow });
  }

  // Finishes a bare-field scan: assembles the value from the prefix, any
  // pieces cut around dropped CRs, and the final plain stretch.
  function fillBare(prefix, pieces, seg, i, kept, end) {
    if (pieces === null) {
      const stretch = text.slice(seg, i);
      slot.value = prefix === '' ? stretch : prefix + stretch;
      slot.kept = i - seg;
    } else {
      if (i > seg) {
        pieces.push(text.slice(seg, i));
        kept += i - seg;
      }
      slot.value = prefix + pieces.join('');
      slot.kept = kept;
    }
    slot.end = end;
    return slot;
  }

  // Reads an unquoted field starting at pos, appending to prefix: '' for
  // a fresh field, the quoted text for what follows a closing quote, or
  // '"' after a quote that never closed. A lone CR met on the way is
  // dropped (stray_cr); a comma, LF or CRLF ends the field.
  function scanBare(prefix) {
    let i = pos;
    let seg = i;
    let pieces = null;
    let kept = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x2c) {
        pos = i + 1;
        return fillBare(prefix, pieces, seg, i, kept, MORE);
      }
      if (c === 0x0a) {
        pos = i + 1;
        line += 1;
        return fillBare(prefix, pieces, seg, i, kept, DONE);
      }
      if (c === 0x0d) {
        if (text.charCodeAt(i + 1) === 0x0a) {
          pos = i + 2;
          line += 1;
          return fillBare(prefix, pieces, seg, i, kept, DONE);
        }
        if (pieces === null) pieces = [];
        if (i > seg) {
          pieces.push(text.slice(seg, i));
          kept += i - seg;
        }
        noteError('stray_cr');
        i += 1;
        seg = i;
        continue;
      }
      i += 1;
    }
    pos = n;
    return fillBare(prefix, pieces, seg, i, kept, EOF);
  }

  // Reads a field whose opening quote is at pos. The hunt for the next
  // quote runs through indexOf; the stretches between quotes are sliced
  // whole, with only their line breaks counted (and, when a stretch holds
  // a CR, the stretch rebuilt with each CR or CRLF read as one LF).
  function scanQuoted() {
    const open = pos;
    let i = open + 1;
    let seg = i;
    let pieces = null;
    let qline = line; // line count inside the quote; committed on close
    for (;;) {
      const q = text.indexOf('"', i);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the
        // text after it is read again as an unquoted field.
        pos = open + 1;
        noteError('unterminated_quote');
        return scanBare('"');
      }
      let stretch;
      const cr = text.indexOf('\r', seg);
      if (cr === -1 || cr >= q) {
        stretch = text.slice(seg, q);
        let m = text.indexOf('\n', seg);
        while (m !== -1 && m < q) {
          qline += 1;
          m = text.indexOf('\n', m + 1);
        }
      } else {
        const parts = [];
        let cut = seg;
        let p = cr;
        let pairs = 0;
        while (p !== -1 && p < q) {
          parts.push(text.slice(cut, p), '\n');
          qline += 1;
          if (text.charCodeAt(p + 1) === 0x0a) {
            pairs += 1;
            p += 2;
          } else {
            p += 1;
          }
          cut = p;
          p = text.indexOf('\r', p);
        }
        parts.push(text.slice(cut, q));
        stretch = parts.join('');
        let m = text.indexOf('\n', seg);
        while (m !== -1 && m < q) {
          qline += 1;
          m = text.indexOf('\n', m + 1);
        }
        qline -= pairs; // an LF swallowed by a CRLF is not a second line
      }
      if (text.charCodeAt(q + 1) === 0x22) {
        // A doubled quote: one literal quote, and the field goes on.
        if (pieces === null) pieces = [];
        pieces.push(stretch, '"');
        i = q + 2;
        seg = i;
        continue;
      }
      // The closing quote at q.
      line = qline;
      let value;
      if (pieces === null) {
        value = stretch;
      } else {
        pieces.push(stretch);
        value = pieces.join('');
      }
      pos = q + 1;
      slot.value = value;
      slot.kept = 0;
      if (pos >= n) {
        slot.end = EOF;
        return slot;
      }
      const c = text.charCodeAt(pos);
      if (c === 0x2c) {
        pos += 1;
        slot.end = MORE;
        return slot;
      }
      if (c === 0x0a) {
        pos += 1;
        line += 1;
        slot.end = DONE;
        return slot;
      }
      if (c === 0x0d && text.charCodeAt(pos + 1) === 0x0a) {
        pos += 2;
        line += 1;
        slot.end = DONE;
        return slot;
      }
      // Anything else after the closing quote is appended as it stands,
      // up to the next comma or line break.
      const junk = scanBare(value);
      if (junk.kept > 0) noteError('quote_junk');
      return junk;
    }
  }

  // Takes one finished record: drops the phantom record a line of only
  // dropped CRs leaves behind, fixes the width on the first record, sets
  // the header, and pads or cuts the record to the width.
  function emitRecord(fields, lastQuoted) {
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) return;
    if (width < 0) width = fields.length;
    if (wantHeader && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 0x0a) {
        pos += 1;
        line += 1;
      } else if (c === 0x0d && text.charCodeAt(pos + 1) === 0x0a) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = wantHeader && columns === null ? null : rows.length;

    // Whole-line fast path: when the rest of this line holds no quote
    // and no CR before the line's content ends, no field can be quoted
    // or span lines, so the record is a plain split on commas.
    const nl = text.indexOf('\n', pos);
    const rawEnd = nl === -1 ? n : nl;
    if (nextQuote !== -1 && nextQuote < pos) nextQuote = text.indexOf('"', pos);
    if (nextCr !== -1 && nextCr < pos) nextCr = text.indexOf('\r', pos);
    const contentEnd =
      nl !== -1 && rawEnd > pos && text.charCodeAt(rawEnd - 1) === 0x0d ? rawEnd - 1 : rawEnd;
    if (
      (nextQuote === -1 || nextQuote >= rawEnd) &&
      (nextCr === -1 || nextCr >= contentEnd)
    ) {
      const fields = [];
      let j = pos;
      for (;;) {
        const comma = text.indexOf(',', j);
        if (comma === -1 || comma >= contentEnd) {
          fields.push(text.slice(j, contentEnd));
          break;
        }
        fields.push(text.slice(j, comma));
        j = comma + 1;
      }
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
      emitRecord(fields, false);
      continue;
    }

    const fields = [];
    let lastQuoted = false;
    let r;
    do {
      if (text.charCodeAt(pos) === 0x22) {
        r = scanQuoted();
        lastQuoted = true;
      } else {
        r = scanBare('');
        lastQuoted = false;
      }
      fields.push(r.value);
    } while (r.end === MORE);
    emitRecord(fields, lastQuoted);
  }

  return { columns: wantHeader ? (columns ?? []) : null, rows, errors };
}
