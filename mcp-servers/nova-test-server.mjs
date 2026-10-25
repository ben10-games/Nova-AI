#!/usr/bin/env node
// Nova test MCP server (stdio). Deliberately harmless: no filesystem, network,
// shell or environment access. Nova starts it with a fixed command and an empty
// environment when MCP_SERVERS=nova-test is set.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "nova-test-server", version: "1.0.0" });

/** In-memory notes: lost when the server process stops. */
const notes = [];

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

server.registerTool(
  "text_stats",
  {
    title: "Text statistics",
    description: "Count the words, characters, lines and sentences in a piece of text.",
    inputSchema: { text: z.string().max(20_000).describe("The text to analyze") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ text: input }) => {
    const words = input.trim() ? input.trim().split(/\s+/).length : 0;
    const sentences = (input.match(/[.!?]+(\s|$)/g) ?? []).length;
    return text({ words, characters: input.length, lines: input.split(/\r?\n/).length, sentences });
  },
);

server.registerTool(
  "convert_temperature",
  {
    title: "Convert temperature",
    description: "Convert a temperature between Celsius (C), Fahrenheit (F) and Kelvin (K).",
    inputSchema: {
      value: z.number().min(-1000).max(100_000).describe("The temperature to convert"),
      from: z.enum(["C", "F", "K"]).describe("Unit of the value"),
      to: z.enum(["C", "F", "K"]).describe("Unit to convert to"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ value, from, to }) => {
    const celsius = from === "C" ? value : from === "F" ? ((value - 32) * 5) / 9 : value - 273.15;
    const result = to === "C" ? celsius : to === "F" ? (celsius * 9) / 5 + 32 : celsius + 273.15;
    return text(`${value} °${from} = ${Math.round(result * 100) / 100} ${to === "K" ? "K" : `°${to}`}`);
  },
);

server.registerTool(
  "add_note",
  {
    title: "Add a note",
    description: "Save a short note in this test server's memory (forgotten when the server stops).",
    inputSchema: { text: z.string().min(1).max(500).describe("The note to save") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ text: note }) => {
    if (notes.length >= 50) return { isError: true, content: [{ type: "text", text: "The note list is full (50 notes)." }] };
    notes.push({ id: notes.length + 1, text: note, savedAt: new Date().toISOString() });
    return text(`Saved note #${notes.length}. The server now holds ${notes.length} note${notes.length === 1 ? "" : "s"}.`);
  },
);

server.registerTool(
  "list_notes",
  {
    title: "List notes",
    description: "List the notes saved in this test server's memory.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => text(notes.length ? notes : "No notes saved yet."),
);

await server.connect(new StdioServerTransport());
