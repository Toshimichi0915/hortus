import { type Piece, editTool, version } from "../index.ts";

export default { name: "builtin:edit", version, plugin: { tools: [editTool] } } satisfies Piece;
