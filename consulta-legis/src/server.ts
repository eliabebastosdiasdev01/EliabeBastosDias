import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { router } from "./consulta-legis/index.js";

const PAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/index.html");
const port = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json());
app.get("/", (_req, res) => res.sendFile(PAGE));
app.use("/api", router);

app.listen(port, () => console.log(`Consulta Legis em http://localhost:${port}`));
