/**
 * Border / frame presets for the video editor.
 *
 * The 8 styles are ported from the `framexshot` screenshot app
 * (`/home/sahilcodex/Documents/framexshot/src/lib/frame-presets.ts`).
 * Each style is described by a small set of stroke / fill / glow /
 * sheen / inset parameters. The `borderStyleToCss` helper converts
 * a style to a CSS object that's applied to a wrapper `<div>` around
 * the video element in the preview; the `renderBorderLayer` helper
 * (see `./renderBorderLayer.ts`) renders the same style to an
 * `OffscreenCanvas` for the export pipeline.
 *
 * Inspired by modern screenshot beautifiers (glass frames, tilted
 * layouts, etc.). The colours are designed to be self-contained so
 * no theme variants are needed.
 */

import type { CSSProperties } from "react";

export type BorderStyleId =
	| "default"
	| "glass-light"
	| "glass-dark"
	| "liquid"
	| "inset-light"
	| "inset-dark"
	| "outline"
	| "border";

export type BorderCornerShape = "square" | "rounded" | "pill";

export interface BorderStyleDef {
	id: BorderStyleId;
	label: string;
	/** Outer padding around the image for the frame chrome (px). */
	padding: number;
	/** Border stroke width (px). */
	strokeWidth: number;
	/** Outer border color. */
	strokeColor: string;
	/** Optional second stroke (inner highlight). */
	innerStrokeColor?: string;
	innerStrokeWidth?: number;
	/** Frame fill behind the image (for glass / inset). */
	fillColor?: string;
	/** Soft outer glow color. */
	glowColor?: string;
	glowBlur?: number;
	/** Draw a top highlight bar (glass sheen). */
	sheen?: boolean;
	sheenColor?: string;
	/** Inset shadow strength 0..1. */
	insetStrength?: number;
	insetColor?: string;
}

// ---------------------------------------------------------------------------
// Preset table
// ---------------------------------------------------------------------------

export const BORDER_STYLES: BorderStyleDef[] = [
	{
		id: "default",
		label: "Plain",
		padding: 0,
		strokeWidth: 0,
		strokeColor: "transparent",
	},
	{
		id: "glass-light",
		label: "Frosted",
		padding: 10,
		strokeWidth: 1.5,
		strokeColor: "rgba(255,255,255,0.55)",
		innerStrokeColor: "rgba(255,255,255,0.25)",
		innerStrokeWidth: 1,
		fillColor: "rgba(255,255,255,0.12)",
		glowColor: "rgba(255,255,255,0.15)",
		glowBlur: 12,
		sheen: true,
		sheenColor: "rgba(255,255,255,0.35)",
	},
	{
		id: "glass-dark",
		label: "Smoky",
		padding: 10,
		strokeWidth: 1.5,
		strokeColor: "rgba(255,255,255,0.18)",
		innerStrokeColor: "rgba(0,0,0,0.35)",
		innerStrokeWidth: 1,
		fillColor: "rgba(20,20,20,0.55)",
		glowColor: "rgba(0,0,0,0.35)",
		glowBlur: 16,
		sheen: true,
		sheenColor: "rgba(255,255,255,0.12)",
	},
	{
		id: "liquid",
		label: "Glow",
		padding: 14,
		strokeWidth: 2.5,
		strokeColor: "rgba(255,140,40,0.85)",
		innerStrokeColor: "rgba(255,200,100,0.4)",
		innerStrokeWidth: 1,
		fillColor: "rgba(255,120,30,0.08)",
		glowColor: "rgba(255,140,40,0.45)",
		glowBlur: 28,
		sheen: true,
		sheenColor: "rgba(255,200,120,0.3)",
	},
	{
		id: "inset-light",
		label: "Raised",
		padding: 8,
		strokeWidth: 1,
		strokeColor: "rgba(0,0,0,0.08)",
		fillColor: "rgba(255,255,255,0.9)",
		insetStrength: 0.35,
		insetColor: "rgba(0,0,0,0.18)",
	},
	{
		id: "inset-dark",
		label: "Carved",
		padding: 8,
		strokeWidth: 1,
		strokeColor: "rgba(255,255,255,0.08)",
		fillColor: "rgba(30,30,30,0.95)",
		insetStrength: 0.5,
		insetColor: "rgba(0,0,0,0.55)",
	},
	{
		id: "outline",
		label: "Outline",
		padding: 4,
		strokeWidth: 2,
		strokeColor: "rgba(255,255,255,0.9)",
	},
	{
		id: "border",
		label: "Frame",
		padding: 6,
		strokeWidth: 6,
		strokeColor: "rgba(255,255,255,0.95)",
	},
];

export function getBorderStyle(id: BorderStyleId): BorderStyleDef {
	return BORDER_STYLES.find((s) => s.id === id) ?? BORDER_STYLES[0];
}

// ---------------------------------------------------------------------------
// CSS projection (preview only — used to render the wrapper <div>)
// ---------------------------------------------------------------------------

export interface BorderCssOverrides {
	/** User-controlled padding override (px). */
	paddingPx?: number;
	/** User-controlled opacity 0..1. */
	opacity?: number;
	/** User-controlled corner shape. */
	cornerShape?: BorderCornerShape;
	/** User-controlled corner radius (px). 0 means square. */
	cornerRadiusPx?: number;
}

/**
 * Convert a `BorderStyleDef` + user overrides into a CSS style object
 * suitable for a wrapper `<div>` around the video. Returns the inline
 * `style` props; the caller applies them. The wrapper should have
 * `display: inline-block` (or similar) and the inner video is sized to
 * fit `100% - 2 * padding` so the border surrounds it.
 */
export function borderStyleToCss(
	def: BorderStyleDef,
	overrides: BorderCssOverrides = {},
): CSSProperties {
	const padding = overrides.paddingPx ?? def.padding;
	const opacity = overrides.opacity ?? 1;
	const cornerShape = overrides.cornerShape ?? "rounded";
	const cornerRadius = overrides.cornerRadiusPx ?? 12;

	const cornerRadiusCss =
		cornerShape === "square"
			? "0"
			: cornerShape === "pill"
				? "9999px"
				: `${cornerRadius}px`;

	// Build a stack of box-shadows: the outer glow first, then the
	// inset shadow (if any), then the inner stroke (if any).
	const shadows: string[] = [];
	if (def.glowColor && def.glowBlur) {
		shadows.push(
			`0 0 ${def.glowBlur}px 0 ${def.glowColor}`,
		);
	}
	if (def.insetColor && def.insetStrength) {
		const blur = Math.round(def.insetStrength * 12);
		shadows.push(
			`inset 0 0 ${blur}px 0 ${def.insetColor}`,
		);
	}
	if (def.innerStrokeColor && def.innerStrokeWidth) {
		shadows.push(
			`inset 0 0 0 ${def.innerStrokeWidth}px ${def.innerStrokeColor}`,
		);
	}

	return {
		padding: `${padding}px`,
		background: def.fillColor ?? "transparent",
		border:
			def.strokeWidth > 0
				? `${def.strokeWidth}px solid ${def.strokeColor}`
				: "none",
		borderRadius: cornerRadiusCss,
		boxShadow: shadows.length > 0 ? shadows.join(", ") : undefined,
		opacity,
		// Position: inline-block so the border hugs the video.
		display: "inline-block",
		// The sheen is rendered via a `::before` pseudo-element in CSS,
		// but we approximate it with a linear-gradient background-image
		// so the same data drives both the preview and the export.
		backgroundImage: def.sheen
			? `linear-gradient(180deg, ${def.sheenColor} 0%, ${def.sheenColor?.replace(
					/[\d.]+\)$/,
					"0)",
				)} 40%)`
			: undefined,
	};
}
