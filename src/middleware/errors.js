/** JSON when the client asks for it (or sends no Accept header), otherwise browser-style. */
export function wantsJson(req) {
  return req.accepts(['json', 'html']) === 'json';
}

export function errorBody(code, message, fields) {
  return { error: { code, message, ...(fields ? { fields } : {}) } };
}

// Never leak stack traces, SQL or secrets (openapi "Errors").
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(400).json(errorBody('validation_error', 'Please check the highlighted fields.'));
  }
  console.error(`Unhandled error: ${err?.code ?? err?.name ?? 'unknown'}`);
  res
    .status(500)
    .json(errorBody('server_error', 'Something went wrong on our side. Your details are saved; try again in a minute.'));
}
