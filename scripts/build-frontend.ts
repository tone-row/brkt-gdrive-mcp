import { build } from "bun";

async function buildFrontend() {
  console.log("Building frontend...");

  const result = await build({
    entrypoints: ["./frontend/App.tsx"],
    outdir: "./dist",
    minify: true,
    splitting: true,
    sourcemap: "external",
    target: "browser",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  // Copy index.html to dist, updating the script path
  const indexHtml = await Bun.file("./index.html").text();
  const updatedHtml = indexHtml.replace(
    '<script type="module" src="./frontend/App.tsx"></script>',
    '<script type="module" src="./App.js"></script>'
  );
  await Bun.write("./dist/index.html", updatedHtml);

  console.log("Frontend build complete!");
  console.log(`Output files:`);
  for (const output of result.outputs) {
    console.log(`  - ${output.path}`);
  }
}

buildFrontend();
