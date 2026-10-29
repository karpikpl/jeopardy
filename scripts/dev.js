const { spawn } = require("node:child_process");
const build = spawn(process.execPath, [require.resolve("typescript/bin/tsc")], { stdio: "inherit" });
build.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const children = [
    spawn(process.execPath, [require.resolve("typescript/bin/tsc"), "--watch"], { stdio: "inherit" }),
    spawn(process.execPath, [require.resolve("nodemon/bin/nodemon.js"), "--watch", "dist", "--watch", "public", "dist/server.js"], { stdio: "inherit" }),
  ];
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => children.forEach((child) => child.kill(signal)));
  }
  for (const child of children) child.on("exit", () => children.forEach((other) => other.kill()));
});
