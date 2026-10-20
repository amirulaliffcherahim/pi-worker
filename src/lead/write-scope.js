// Declared write scope. Each writer slice lists the files or globs it may change in `writes`.
// The gate compares declarations, not prose, so a file that is only read in a brief never causes a refusal,
// and a writer with no declaration is refused instead of guessed at.

const GLOB_CHARS = /[*?[\]{}]/;

export function normalizeScope(raw) {
	return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/$/, "").toLowerCase();
}

/** The part of a pattern before its first wildcard, cut back to a whole directory. "src/auth/**" -> "src/auth". */
export function literalPrefix(pattern) {
	const at = pattern.search(GLOB_CHARS);
	if (at < 0)
		return pattern;
	const head = pattern.slice(0, at);
	const slash = head.lastIndexOf("/");
	return slash < 0 ? "" : head.slice(0, slash);
}

export function isGlob(pattern) {
	return GLOB_CHARS.test(pattern);
}

function isWithin(child, parent) {
	return parent === "" || child === parent || child.startsWith(`${parent}/`);
}

/**
 * Whether two declared patterns can name the same file. Exact files match exactly; a glob claims everything under its
 * literal directory. Conservative on purpose: when unsure, they overlap, because a false refusal costs one re-launch
 * and a missed overlap costs a corrupted file.
 */
export function scopesOverlap(a, b) {
	const left = normalizeScope(a);
	const right = normalizeScope(b);
	if (left === right)
		return true;
	const leftGlob = isGlob(left);
	const rightGlob = isGlob(right);
	if (!leftGlob && !rightGlob)
		return false;
	const leftBase = literalPrefix(left);
	const rightBase = literalPrefix(right);
	if (leftGlob && rightGlob)
		return isWithin(leftBase, rightBase) || isWithin(rightBase, leftBase);
	const [file, glob] = leftGlob ? [right, left] : [left, right];
	return isWithin(file, literalPrefix(glob));
}

export function cleanWrites(value) {
	if (!Array.isArray(value))
		return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim() !== "");
}

/** First pair of patterns across two units that overlap, or undefined. */
export function firstOverlap(leftWrites, rightWrites) {
	for (const left of leftWrites) {
		for (const right of rightWrites) {
			if (scopesOverlap(left, right))
				return { left, right };
		}
	}
	return undefined;
}

/** Scope patterns that would let a slice write anywhere. These defeat the point of declaring a scope. */
export function isUnbounded(pattern) {
	const normalized = normalizeScope(pattern);
	return normalized === "" || normalized === "*" || normalized === "**" || normalized === "**/*" || normalized === ".";
}
