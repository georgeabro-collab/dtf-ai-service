import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("dtf-ai-service is running"));

app.listen(port, () => console.log(`Listening on ${port}`));
