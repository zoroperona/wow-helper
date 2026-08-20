import { buildStaticPublication } from "./pages-publication.js";

const result = await buildStaticPublication();
console.log(
  `[pages] Built ${result.playerCount} players at ${result.outputPath} (revision ${result.revision})`,
);
