export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );

export const multiline = (value) => escapeHtml(value).replaceAll('\n', '<br>');
export const jsonScript = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
export const arrow = '<span aria-hidden="true">↗</span>';
export const discord =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M19.8 5a18 18 0 0 0-4.4-1.4l-.6 1.2a16 16 0 0 0-5.6 0l-.6-1.2A18 18 0 0 0 4.2 5C1.4 9.2.6 13.3 1 17.3a18 18 0 0 0 5.5 2.8l1.1-1.8-1.7-.9.4-.3c3.6 1.7 7.8 1.7 11.4 0l.4.3-1.7.9 1.1 1.8a18 18 0 0 0 5.5-2.8c.5-4.6-.8-8.6-3.2-12.3ZM8.4 14.8c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm7.2 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z"/></svg>';
