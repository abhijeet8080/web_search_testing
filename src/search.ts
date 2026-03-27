import { exa } from "./exaClient.js";

const normalizedQuery =
  process.env.QUERY ?? "Siemens 6ES7515-2AM02-0AB0 PLC";

const procurementPrompt = `You are an AI procurement assistant for an industrial distributor (MRO / industrial automation).
You have access to a web search tool. Use it to find manufacturers and authorized distributors for the product below.

The product has already been validated as a real, purchasable item - skip any existence checks.

---
TASK: FIND MANUFACTURERS AND AUTHORIZED DISTRIBUTORS

Search the web for the product below and find ONLY:
- The ORIGINAL MANUFACTURER of the product (the company that makes/produces it)
- AUTHORIZED DISTRIBUTORS (companies officially authorized by the manufacturer to sell/distribute this product)
- Official regional distributors or factory-authorized resellers

DO NOT include:
- Unauthorized resellers or gray-market sellers
- General distributors without manufacturer authorization
- Third-party marketplaces or aggregators (eBay, Amazon, Alibaba, etc.)
- Companies that only resell without official authorization

---
PRODUCT QUERY:
"${normalizedQuery}"

OUTPUT:
Return the response strictly as VALID JSON (parsable by JSON.parse), with NO text before or after it.

JSON FORMAT (exact keys, no extras):

{
  "success": true,
  "vendors": [
    {
      "name": "<vendor name>",
      "website": "<main website URL>",
      "email": "<verified sales or quotation email>",
      "phone": "<phone number or empty string>",
      "country": "<country or region or empty string>",
      "source": "<URL where you found this vendor & email>",
      "type": "<MANUFACTURER or AUTHORIZED_DISTRIBUTOR>"
    }
  ]
}

STRICT RULES:
- Output MUST be valid JSON. No markdown, no backticks, no comments, no explanations.
- "vendors" MUST be an array. If no qualified vendors are found, use "vendors": [].
- ONLY include vendors that:
  * Are the ORIGINAL MANUFACTURER of the product, OR
  * Are explicitly listed as AUTHORIZED DISTRIBUTORS by the manufacturer (check manufacturer websites, authorized dealer lists, official distributor directories)
  * Have a REAL, VERIFIED sales/quotation email visible on their website or the source URL
- For each vendor, set "type" to either "MANUFACTURER" or "AUTHORIZED_DISTRIBUTOR"
- If you cannot find a verified email, DO NOT include that vendor in the "vendors" array.
- NEVER invent or guess emails. Only include an email if it is explicitly shown on the vendor's own site or a trusted listing.
- Prefer vendors in the same region as the product description if obvious, otherwise worldwide is fine.
- Try to find up to 10 vendors if possible, but prioritize quality (verified manufacturer/authorized status and verified emails) over quantity.
- If the product query is too vague or generic to identify a specific manufacturer even after web search, return "vendors": [] with success: true.`;

// Basic search + contents (highlights).
const results = await exa.searchAndContents(procurementPrompt, {
  type: "auto",
  numResults: 5,
  contents: {
    highlights: {
      maxCharacters: 4000,
    },
  },
});

console.log(JSON.stringify(results, null, 2));

