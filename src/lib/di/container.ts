/**
 * The root container only. Registrations live in src/bootstrap.ts so that lib/ never imports app/
 * (CLAUDE.md -> Folder structure and layering).
 */
export { container } from "tsyringe";
