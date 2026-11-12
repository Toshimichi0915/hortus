import { type Piece, readTool, version } from "../index.ts";

export default { name: "builtin:read", version, plugin: { tools: [readTool] } } satisfies Piece;
