import "dotenv/config";
import {
  discoverVendorProductUrlAndNotes,
  type VendorProductUrlNotesParams,
} from "./test_fetch_product_url.js";

type CliArgs = {
  itemDescription: string;
  vendorWebsite?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const options = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key) continue;

    if (key.startsWith("--")) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        options.set(key, value);
        i += 1;
      }
      continue;
    }

    positional.push(key);
  }

  return {
    itemDescription: options.get("--item") ?? positional[0] ?? "ASTRO PNEUMATIC 218 PENCIL TYPE DIE GRINDER 1/8",
    vendorWebsite: options.get("--vendor-website") ?? positional[1],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const params: VendorProductUrlNotesParams = {
    itemDescription: args.itemDescription,
    manufacturer: null,
    quantity: 1,
    vendorWebsite: args.vendorWebsite,
  };

  console.log("[run_test_fetch_product_url] Running with params:");
  console.log(JSON.stringify(params, null, 2));

  const result = await discoverVendorProductUrlAndNotes(params);

  console.log("\n[run_test_fetch_product_url] Result:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[run_test_fetch_product_url] Failed:", err);
  process.exit(1);
});
