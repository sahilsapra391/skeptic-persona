// Vite `?raw` imports (fixtures inlined as strings for the workerd test pool).
// Must live in a standalone declaration file: wildcard ambient modules are
// ignored when declared inside a module (a file with imports).
declare module "*?raw" {
  const content: string;
  export default content;
}
