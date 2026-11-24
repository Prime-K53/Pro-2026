// Backward-compatible re-export. The pure fixed-point decimal helpers now live in
// `src/shared/decimal.ts` so both the server and the browser can use them without
// the client importing from `server/`. Existing server imports of this module keep
// working unchanged.
export * from '../../shared/decimal.ts';