import { type Piece, bashTool, version } from "../index.ts";

export default { name: "builtin:bash", version, plugin: { tools: [bashTool] } } satisfies Piece;
