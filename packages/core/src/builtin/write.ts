import { type Piece, writeTool, version } from "../index.ts";

export default { name: "builtin:write", version, plugin: { tools: [writeTool] } } satisfies Piece;
