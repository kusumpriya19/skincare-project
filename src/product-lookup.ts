export type ProductSnapshot = {
	name: string;
	url: string;
	price: number | null;
	currency: string | null;
	size: number | null;
	sizeUnit: "ml" | "g" | null;
	ingredients: string[];
	activeIngredients: string[];
	activeLevels: string[];
};

const CANDIDATE_URLS = [
	"https://beminimalist.co/products/niacinamide-10-with-matmarine",
	"https://thedermaco.com/collections/face-serum/products/10-percent-niacinamide-serum",
	"https://www.dotandkey.com/products/10-niacinamide-strawberry-brightening-face-serum",
];

// Retail pages sometimes block Workers or render ingredients only in the browser.
// These small catalog records keep the demo usable in those cases. They contain
// only the named active, so they are intentionally less precise than a live list.
const STARTER_CATALOG_FALLBACK: ProductSnapshot[] = [
	{
		name: "Minimalist Niacinamide 10% + Matmarine",
		url: CANDIDATE_URLS[0], price: null, currency: "INR", size: null, sizeUnit: null,
		ingredients: ["Niacinamide"], activeIngredients: ["Niacinamide"], activeLevels: ["Niacinamide: 10%"],
	},
	{
		name: "The Derma Co 10% Niacinamide Serum",
		url: CANDIDATE_URLS[1], price: null, currency: "INR", size: null, sizeUnit: null,
		ingredients: ["Niacinamide"], activeIngredients: ["Niacinamide"], activeLevels: ["Niacinamide: 10%"],
	},
	{
		name: "Dot & Key 10% Niacinamide + Strawberry Brightening Face Serum",
		url: CANDIDATE_URLS[2], price: null, currency: "INR", size: null, sizeUnit: null,
		ingredients: ["Niacinamide"], activeIngredients: ["Niacinamide"], activeLevels: ["Niacinamide: 10%"],
	},
];

const ACTIVE_PATTERNS: Array<[string, RegExp]> = [
	["Niacinamide", /\bniacinamide\b/i],
	["Zinc PCA", /\bzinc\s+pca\b/i],
	["Salicylic acid", /\bsalicylic\s+acid\b/i],
	["Alpha arbutin", /\balpha\s+arbutin\b/i],
	["Tranexamic acid", /\btranexamic\s+acid\b/i],
	["Hyaluronic acid", /\b(?:hyaluronic\s+acid|sodium\s+hyaluronate)\b/i],
	["Retinoid", /\b(?:retinol|retinal|retinoate)\b/i],
	["Vitamin C", /\b(?:vitamin\s+c|ascorbic\s+acid|ascorbyl|tetrahexyldecyl\s+ascorbate)\b/i],
	["Azelaic acid", /\bazelaic\s+acid\b/i],
	["Glycolic acid", /\bglycolic\s+acid\b/i],
];

function validateProductUrl(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("That does not look like a valid product URL.");
	}
	const host = url.hostname.toLowerCase();
    if (host === "inkeedecoder.com" || host.endsWith(".inkeedecoder.com") || host === "incidecoder.com" || host.endsWith(".incidecoder.com")) {
        throw new Error("INKEEDecoder does not allow automated data mining or copying its database. Use the manual search link and paste the ingredients here.");
    }
	if (rawUrl.length > 2048) throw new Error("That product URL is too long.");
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		!host ||
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		host.endsWith(".test") ||
		host.includes(":") ||
		/^\d+(?:\.\d+){3}$/.test(host)
	) {
		throw new Error("For safety, product links must use HTTPS and a public domain name.");
	}
	url.hash = "";
	return url;
}

function decodeEntities(value: string): string {
	return value
		.replace(/&nbsp;|&#160;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
			.replace(/<!--([\s\S]*?)-->/g, " ")
			.replace(/<\/(?:p|div|li|h[1-6]|section|article|tr|br|dd|dt|ul|ol)\s*>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/[\t\r ]+/g, " ")
			.replace(/\n\s+/g, "\n"),
	).trim();
}

async function readLimited(response: Response, limit: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < limit) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			const remaining = limit - total;
			const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
			chunks.push(chunk);
			total += chunk.byteLength;
			if (chunk.byteLength < value.byteLength) {
				await reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(joined);
}

async function fetchProductPage(rawUrl: string): Promise<{ url: string; html: string }> {
	let url = validateProductUrl(rawUrl);
	for (let redirects = 0; redirects <= 3; redirects += 1) {
		const response = await fetch(url, {
			method: "GET",
			redirect: "manual",
			headers: { accept: "text/html,application/xhtml+xml" },
			signal: AbortSignal.timeout(12_000),
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location || redirects === 3) throw new Error("The product page redirected too many times.");
			url = validateProductUrl(new URL(location, url).toString());
			continue;
		}
		if (!response.ok) throw new Error(`The product page returned HTTP ${response.status}.`);
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("text/html") && !contentType.includes("xhtml")) {
			throw new Error("That link did not return a readable product page.");
		}
		return { url: url.toString(), html: await readLimited(response, 700_000) };
	}
	throw new Error("Could not load the product page.");
}

function walkObjects(value: unknown, output: Record<string, unknown>[], depth = 0): void {
	if (depth > 12 || value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) walkObjects(item, output, depth + 1);
		return;
	}
	const object = value as Record<string, unknown>;
	output.push(object);
	for (const nested of Object.values(object)) walkObjects(nested, output, depth + 1);
}

function getStructuredProduct(html: string): Record<string, unknown> | undefined {
	const objects: Record<string, unknown>[] = [];
	for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
		try {
			walkObjects(JSON.parse(decodeEntities(match[1])), objects);
		} catch {
			// Ignore malformed JSON-LD and continue with the page metadata.
		}
	}
	return objects.find((object) => {
		const type = object["@type"];
		return (typeof type === "string" && /product/i.test(type)) ||
			(Array.isArray(type) && type.some((entry) => /product/i.test(String(entry))));
	});
}

function readMeta(html: string, wanted: string): string | undefined {
	for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
		const tag = match[0];
		const key = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
		if (key !== wanted.toLowerCase()) continue;
		return tag.match(/content=["']([^"']*)["']/i)?.[1];
	}
	return undefined;
}

function readPrice(product: Record<string, unknown> | undefined, html: string, text: string, productName: string): { price: number | null; currency: string | null } {
	const metaPrice = readMeta(html, "product:price:amount") ?? readMeta(html, "og:price:amount");
	const metaCurrency = readMeta(html, "product:price:currency") ?? readMeta(html, "og:price:currency");
	const parsedMeta = Number(metaPrice);
	if (Number.isFinite(parsedMeta) && parsedMeta > 0) {
		return { price: parsedMeta, currency: metaCurrency ?? null };
	}
	const offers = product?.offers;
	const offer = Array.isArray(offers) ? offers[0] as Record<string, unknown> | undefined : offers as Record<string, unknown> | undefined;
	const structuredPrice = Number(offer?.price ?? product?.price);
	const structuredCurrency = String(offer?.priceCurrency ?? product?.priceCurrency ?? "");
	if (Number.isFinite(structuredPrice) && structuredPrice > 0) {
		return { price: structuredPrice, currency: structuredCurrency || null };
	}
	const nameAt = productName ? text.toLowerCase().indexOf(productName.toLowerCase()) : -1;
	const productArea = nameAt >= 0 ? text.slice(nameAt, nameAt + 1800) : text.slice(0, 1800);
	const priceMatch = productArea.match(/(?:\u20B9|\bINR\s*|\bRs\.?\s*)([\d,]+(?:\.\d{1,2})?)/i);
	if (!priceMatch) return { price: null, currency: null };
	const price = Number(priceMatch[1].replace(/,/g, ""));
	return { price: Number.isFinite(price) ? price : null, currency: "INR" };
}
function readIngredients(text: string): string[] {
	const headings = [
		/all\s+ingredients\b/i,
		/full\s+ingredient\s+list\b/i,
		/ingredients\s+list\b/i,
		/see\s+full\s+ingredients\b/i,
		/\bingredients\b/i,
	];
	for (const heading of headings) {
		const match = heading.exec(text);
		if (!match || match.index === undefined) continue;
		const after = text.slice(match.index + match[0].length, match.index + match[0].length + 5000);
		const lines = after.split("\n").map((line) => line.trim()).filter(Boolean);
		const line = lines.find((candidate) => candidate.includes(",") && candidate.length > 70 && candidate.length < 5000);
		if (!line) continue;
		const ingredients = line.split(",").map((item) => item.trim().replace(/^[\d.)\s-]+/, "").replace(/[.;:]+$/, "")).filter((item) => item.length > 1 && item.length < 100);
		if (ingredients.length >= 5) return ingredients.slice(0, 120);
	}
	return [];
}

function readSize(text: string, name: string): { size: number | null; sizeUnit: "ml" | "g" | null } {
	const nameAt = name ? text.toLowerCase().indexOf(name.toLowerCase()) : -1;
	const nearby = nameAt >= 0 ? text.slice(nameAt, nameAt + 1000) : text.slice(0, 1000);
	const match = nearby.match(/\b(\d{1,4}(?:\.\d+)?)\s*(ml|g)\b/i);
	if (!match) return { size: null, sizeUnit: null };
	return { size: Number(match[1]), sizeUnit: match[2].toLowerCase() as "ml" | "g" };
}

function activeFacts(text: string): { activeIngredients: string[]; activeLevels: string[] } {
	const activeIngredients: string[] = [];
	const activeLevels: string[] = [];
	for (const [name, pattern] of ACTIVE_PATTERNS) {
		if (!pattern.test(text)) continue;
		activeIngredients.push(name);
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const level = text.match(new RegExp(`(\\d+(?:\\.\\d+)?\\s*%)\\s*(?:pure\\s+)?${escaped}\\b`, "i"))?.[1];
		if (level) activeLevels.push(`${name}: ${level}`);
	}
	return { activeIngredients, activeLevels };
}

export function parseProductPage(url: string, html: string): ProductSnapshot {
	const product = getStructuredProduct(html);
	const text = htmlToText(html);
	const title = readMeta(html, "og:title") ?? readMeta(html, "twitter:title") ?? "";
	const name = String(product?.name ?? (title.replace(/\s*[|–—-]\s*[^|–—-]+$/, "").trim() || text.slice(0, 120)));
	const { price, currency } = readPrice(product, html, text, name);
	const { size, sizeUnit } = readSize(text, name);
	const ingredients = readIngredients(text);
	const productAt = text.toLowerCase().indexOf(name.toLowerCase());
	const nearbyText = productAt >= 0 ? text.slice(productAt, productAt + 7000) : text.slice(0, 7000);
	const activeSource = `${name}\n${nearbyText}\n${ingredients.join(", ")}`;
	const { activeIngredients, activeLevels } = activeFacts(activeSource);
	return { name, url, price, currency, size, sizeUnit, ingredients, activeIngredients, activeLevels };
}

function ingredientKey(ingredient: string): string {
	return ingredient.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\b(?:aqua|water)\b/g, "water").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizedIngredients(product: ProductSnapshot): Set<string> {
	return new Set(product.ingredients.map(ingredientKey).filter(Boolean));
}

function comparableUnitPrice(product: ProductSnapshot): number | null {
	if (product.price === null || !product.size || product.size <= 0) return null;
	return product.price / product.size;
}

function productLabel(product: ProductSnapshot): string {
	const size = product.size && product.sizeUnit ? ` (${product.size}${product.sizeUnit})` : "";
	const price = product.price === null ? "price not found" : (product.currency === "INR" ? "\u20B9" : product.currency ?? "") + product.price.toFixed(2);
	return product.name + size + " - " + price;
}

function normalizedCurrency(currency: string | null): string | null {
	if (!currency) return null;
	const value = currency.trim().toUpperCase();
	return value === '\u20B9' || value === 'RS' || value === 'RS.' ? 'INR' : value;
}

function sameCurrency(a: ProductSnapshot, b: ProductSnapshot): boolean {
	const first = normalizedCurrency(a.currency);
	const second = normalizedCurrency(b.currency);
	return first !== null && first === second;
}

function isCheaper(candidate: ProductSnapshot, source: ProductSnapshot): boolean {
	if (!sameCurrency(candidate, source)) return false;
	const candidateUnit = comparableUnitPrice(candidate);
	const sourceUnit = comparableUnitPrice(source);
	if (candidateUnit !== null && sourceUnit !== null) {
		if (candidate.sizeUnit !== source.sizeUnit) return false;
		return candidateUnit < sourceUnit;
	}
	if (candidate.size && source.size && candidate.sizeUnit !== source.sizeUnit) return false;
	if (candidate.price !== null && source.price !== null) return candidate.price < source.price;
	return false;
}

function catalogProducts(pages: Array<{ url: string; html: string } | null>, sourceUrl?: string): ProductSnapshot[] {
	return STARTER_CATALOG_FALLBACK.map((fallback, index) => {
		const page = pages[index];
		if (!page) return fallback;
		const parsed = parseProductPage(page.url, page.html);
		if (parsed.ingredients.length >= 5) return parsed;
		return { ...fallback, price: parsed.price, currency: parsed.currency ?? fallback.currency, size: parsed.size, sizeUnit: parsed.sizeUnit };
	}).filter((candidate) => sourceUrl === undefined || new URL(candidate.url).hostname !== new URL(sourceUrl).hostname);
}

export async function findAffordableAlternatives(rawUrl: string): Promise<string> {
	const url = validateProductUrl(rawUrl).toString();
	const [sourcePage, ...candidatePages] = await Promise.all([
		fetchProductPage(url),
		...CANDIDATE_URLS.map((candidate) => fetchProductPage(candidate).catch(() => null)),
	]);
	const source = parseProductPage(sourcePage.url, sourcePage.html);
	const candidateProducts = catalogProducts(candidatePages, source.url);

	if (source.ingredients.length < 5) {
		return JSON.stringify({
			status: "ingredients_missing",
			message: "I could open the product page, but could not confidently extract its full ingredient list. Ask the user to paste the list from the retailer page or package. The candidate ingredient lists and prices below are available for a manual comparison.",
			source: {
				name: source.name,
				url: source.url,
                ingredientLookupSearchUrl: "https://inkeedecoder.com/search?activetab=products&query=" + encodeURIComponent(source.name),
				price: source.price,
				currency: source.currency,
				size: source.size,
				sizeUnit: source.sizeUnit,
				pricePerUnit: comparableUnitPrice(source),
			},
			candidates: candidateProducts.map((candidate) => ({
				name: candidate.name,
				url: candidate.url,
				price: candidate.price,
				currency: candidate.currency,
				size: candidate.size,
				sizeUnit: candidate.sizeUnit,
				pricePerUnit: comparableUnitPrice(candidate),
				activeIngredients: candidate.activeIngredients,
				activeLevels: candidate.activeLevels,
				ingredients: candidate.ingredients,
			})),
			catalogScope: "The starter catalog currently contains a few niacinamide face serums sold in India.",
		});
	}

	const sourceKeys = normalizedIngredients(source);
	const sourceByKey = new Map(source.ingredients.map((ingredient) => [ingredientKey(ingredient), ingredient]));
	const sourceActives = new Set(source.activeIngredients);
	const candidates = candidateProducts
		.map((candidate) => {
			const candidateKeys = normalizedIngredients(candidate);
			const candidateByKey = new Map(candidate.ingredients.map((ingredient) => [ingredientKey(ingredient), ingredient]));
			const sharedKeys = [...sourceKeys].filter((ingredient) => candidateKeys.has(ingredient));
			const sharedIngredients = sharedKeys.map((key) => sourceByKey.get(key) ?? key);
			const sourceOnlyIngredients = [...sourceByKey]
                .filter(([key]) => !candidateKeys.has(key))
                .map(([, ingredient]) => ingredient)
                .slice(0, 12);
            const candidateOnlyIngredients = [...candidateByKey]
				.filter(([key]) => !sourceKeys.has(key))
				.map(([, ingredient]) => ingredient)
				.slice(0, 12);
			const sharedActives = source.activeIngredients.filter((active) => candidate.activeIngredients.includes(active));
			const missingActives = [...sourceActives].filter((active) => !candidate.activeIngredients.includes(active));
			const ingredientSimilarity = sourceKeys.size ? sharedKeys.length / sourceKeys.size : 0;
			const activeSimilarity = sourceActives.size ? sharedActives.length / sourceActives.size : 0;
			const score = Math.round((activeSimilarity * 0.7 + ingredientSimilarity * 0.3) * 100);
			return {
				name: candidate.name,
				url: candidate.url,
				price: candidate.price,
				currency: candidate.currency,
				size: candidate.size,
				sizeUnit: candidate.sizeUnit,
				pricePerUnit: comparableUnitPrice(candidate),
				cheaper: isCheaper(candidate, source),
				priceComparison: !sameCurrency(candidate, source)
					? "not comparable: currencies differ or are missing"
					: candidate.size && source.size && candidate.sizeUnit === source.sizeUnit
						? "price per matching unit"
						: "listed price only; package size could not be normalized",
				matchScore: score,
				sharedActives,
				missingActives,
				sharedIngredients: sharedIngredients.slice(0, 12),
                sourceOnlyIngredients,
				candidateOnlyIngredients,
				activeLevels: candidate.activeLevels,
			};
		})
		.sort((a, b) => Number(b.cheaper) - Number(a.cheaper) || b.matchScore - a.matchScore);
	return JSON.stringify({
		status: "ok",
		source: {
			name: source.name,
			url: source.url,
			price: source.price,
			currency: source.currency,
			size: source.size,
			sizeUnit: source.sizeUnit,
			pricePerUnit: comparableUnitPrice(source),
			ingredientsFound: source.ingredients.length,
			activeIngredients: source.activeIngredients,
			activeLevels: source.activeLevels,
		},
		candidates,
		catalogScope: "This starter catalog currently contains only a few niacinamide face serums sold in India. Page prices and ingredient lists can change; link back to the live retailer page and tell the user to verify before buying.",
		comparisonNotes: [
			"Prefer price per ml or g when both product sizes and currencies are known; otherwise compare listed prices only when currencies match and say the size could not be matched.",
			"Do not compare numeric prices across different currencies.",
			"Ingredient order gives only a rough position signal; do not infer exact percentages unless the page states them.",
			"A shared active ingredient does not prove identical formulation, strength, performance, or suitability.",
		],
	});
}




export async function comparePastedIngredients(rawIngredients: string): Promise<string> {
	const ingredients = rawIngredients.split(/[\n,;]+/).map((item) => item.trim().replace(/^[\d.)\s-]+/, "").replace(/[.;:]+$/, "")).filter((item) => item.length > 1 && item.length < 100).slice(0, 120);
	if (ingredients.length < 5) return JSON.stringify({ status: "ingredients_incomplete", message: "Please paste at least five ingredients, separated by commas or one per line." });
	const source: ProductSnapshot = { name: "Your pasted product", url: "", price: null, currency: null, size: null, sizeUnit: null, ingredients, ...activeFacts(ingredients.join(", ")) };
	const pages = await Promise.all(CANDIDATE_URLS.map((url) => fetchProductPage(url).catch(() => null)));
	const candidates = catalogProducts(pages).map((candidate) => {
		const sourceKeys = normalizedIngredients(source);
		const candidateKeys = normalizedIngredients(candidate);
		const shared = [...sourceKeys].filter((key) => candidateKeys.has(key));
		const sharedActives = source.activeIngredients.filter((active) => candidate.activeIngredients.includes(active));
		return { name: candidate.name, url: candidate.url, price: candidate.price, currency: candidate.currency, size: candidate.size, sizeUnit: candidate.sizeUnit, activeIngredients: candidate.activeIngredients, activeLevels: candidate.activeLevels, sharedActives, sharedIngredients: shared.slice(0, 12), ingredientOverlap: sourceKeys.size ? Math.round(shared.length / sourceKeys.size * 100) : 0 };
	}).sort((a, b) => b.sharedActives.length - a.sharedActives.length || b.ingredientOverlap - a.ingredientOverlap);
	return JSON.stringify({ status: "manual_comparison", source: { name: source.name, ingredientCount: ingredients.length, activeIngredients: source.activeIngredients }, candidates, note: "The source product price and active concentrations were not provided, so this comparison cannot establish which option is cheaper or equally strong. Ingredient overlap is only a rough similarity signal." });
}
