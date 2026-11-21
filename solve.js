// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly what csv-reader's
// readCsv returns for {text, header} -> {columns, rows, errors}, but reads the text with
// slice-and-jump scans instead of one character at a time, in one flat loop: the
// field readers are inlined in the record loop, because a function call per field
// cost more than the scan itself (the closure version ran ~2.4x slower).
//
// Semantics (csv-reader 1.0.0's written broken-row policy, as its vendor code reads it):
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside
//     it one quote, and each CRLF or lone CR inside it is read as LF; what follows its
//     closing quote, up to the next comma or line break, is appended to it as it stands
//     (quote_junk, when the field ends); a quote that never closes is read as a literal
//     character and the text after it is read again as an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it (every record when header is false), each padded with "" (short_row, with
//     fields: its count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on
//     (every LF, CRLF and lone CR inside a quoted field counted), row its record's index
//     in rows (null for the header), in the order met.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Delimiters of an unquoted field: comma, LF, CR.
const RE_UNQUOTED = /[,\n\r]/g;
// Delimiters inside a quoted field: quote, CR, LF.
const RE_QUOTED = /["\r\n]/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // (The field readers are inlined in the record loop below: a function call per
  // field cost more than the scan itself.)

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;

    // One field at a time, its readers inlined here: a function call per field cost
    // more than the scan itself, so each field is read where it stands.
    while (true) {
      let value;
      let ended;
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        // A quoted field whose opening quote is at pos.
        const open = pos;
        const openLine = line;
        value = '';
        pos += 1;
        let closed = false;
        while (pos < n) {
          RE_QUOTED.lastIndex = pos;
          const m = RE_QUOTED.exec(text);
          if (m === null) break;
          const i = m.index;
          const c = text.charCodeAt(i);
          if (c === 34) {
            if (text.charCodeAt(i + 1) === 34) {
              const seg = text.slice(pos, i);
              value = value === '' ? seg + '"' : value + seg + '"';
              pos = i + 2;
              continue;
            }
            if (i > pos) {
              const seg = text.slice(pos, i);
              value = value === '' ? seg : value + seg;
            }
            pos = i + 1;
            closed = true;
            break;
          }
          // CRLF and a lone CR inside quotes are each one LF.
          if (i > pos) {
            const seg = text.slice(pos, i);
            value = value === '' ? seg : value + seg;
          }
          value += '\n';
          line += 1;
          pos = c === 13 && text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text after it
          // is read again as an unquoted field.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          value = '"';
          let added = 0;
          let unqEnded = END;
          while (pos < n) {
            RE_UNQUOTED.lastIndex = pos;
            const m = RE_UNQUOTED.exec(text);
            if (m === null) {
              const seg = text.slice(pos);
              value += seg;
              added += seg.length;
              pos = n;
              unqEnded = END;
              break;
            }
            const i = m.index;
            if (i > pos) {
              const seg = text.slice(pos, i);
              value += seg;
              added += seg.length;
            }
            const c2 = text.charCodeAt(i);
            if (c2 === 44) { pos = i + 1; unqEnded = COMMA; break; }
            if (c2 === 10) { pos = i + 1; line += 1; unqEnded = LINE_BREAK; break; }
            if (text.charCodeAt(i + 1) === 10) { pos = i + 2; line += 1; unqEnded = LINE_BREAK; break; }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            pos = i + 1;
          }
          ended = unqEnded;
        } else if (pos >= n) {
          ended = END;
        } else {
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            ended = COMMA;
          } else if (c === 10) {
            pos += 1;
            line += 1;
            ended = LINE_BREAK;
          } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            ended = LINE_BREAK;
          } else {
            // What follows the closing quote is appended as it stands, up to the
            // next comma or line break.
            let added = 0;
            let unqEnded = END;
            while (pos < n) {
              RE_UNQUOTED.lastIndex = pos;
              const m = RE_UNQUOTED.exec(text);
              if (m === null) {
                const seg = text.slice(pos);
                value = added === 0 && value === '' ? seg : value + seg;
                added += seg.length;
                pos = n;
                unqEnded = END;
                break;
              }
              const i = m.index;
              if (i > pos) {
                const seg = text.slice(pos, i);
                value = added === 0 && value === '' ? seg : value + seg;
                added += seg.length;
              }
              const c2 = text.charCodeAt(i);
              if (c2 === 44) { pos = i + 1; unqEnded = COMMA; break; }
              if (c2 === 10) { pos = i + 1; line += 1; unqEnded = LINE_BREAK; break; }
              if (text.charCodeAt(i + 1) === 10) { pos = i + 2; line += 1; unqEnded = LINE_BREAK; break; }
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              pos = i + 1;
            }
            if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            ended = unqEnded;
          }
        }
      } else {
        quoted = false;
        // An unquoted field: up to the next comma or line break; a CR not followed
        // by LF is dropped (stray_cr).
        value = '';
        let added = 0;
        let unqEnded = END;
        while (pos < n) {
          RE_UNQUOTED.lastIndex = pos;
          const m = RE_UNQUOTED.exec(text);
          if (m === null) {
            const seg = text.slice(pos);
            value = added === 0 && value === '' ? seg : value + seg;
            added += seg.length;
            pos = n;
            unqEnded = END;
            break;
          }
          const i = m.index;
          if (i > pos) {
            const seg = text.slice(pos, i);
            value = added === 0 && value === '' ? seg : value + seg;
            added += seg.length;
          }
          const c2 = text.charCodeAt(i);
          if (c2 === 44) { pos = i + 1; unqEnded = COMMA; break; }
          if (c2 === 10) { pos = i + 1; line += 1; unqEnded = LINE_BREAK; break; }
          if (text.charCodeAt(i + 1) === 10) { pos = i + 2; line += 1; unqEnded = LINE_BREAK; break; }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          pos = i + 1;
        }
        ended = unqEnded;
      }
      fields.push(value);
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
