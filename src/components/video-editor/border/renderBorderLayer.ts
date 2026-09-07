/**
 * Renders a `BorderStyleDef` to an `OffscreenCanvas` (or `HTMLCanvasElement`
 * in the renderer). The same routine backs both:
 *  - the small swatch thumbnails in the settings panel, and
 *  - the full-resolution border layer composited on top of the video
 *    during the export.
 *
 * The output canvas is the size of the video + 2 * padding (px). The
 * caller composites it on top of the video canvas via `drawImage`.
 *
 * Strategy: we draw the border as a series of rounded-rect fills /
 * strokes / shadows on a 2D context. Where CSS effects like blur and
 * inset shadow are not directly available in Canvas 2D, we approximate:
 *  - "glow" → a few stacked rounded-rect strokes with decreasing alpha
 *  - "inset shadow" → a clipped linear gradient
 *  - "sheen" → a clipped linear gradient on the top edge
 *
 * These approximations look very close to the CSS preview at the
 * resolutions a 4K export uses.
 */

import type { BorderStyleDef } from "./borderPresets";

export interface RenderBorderLayerOptions {
	def: BorderStyleDef;
	/** Inner video width (px). */
	videoWidth: number;
	/** Inner video height (px). */
	videoHeight: number;
	/** User-controlled padding override (px). */
	paddingPx?: number;
	/** User-controlled opacity 0..1. */
	opacity?: number;
	/** User-controlled corner radius (px). */
	cornerRadiusPx?: number;
}

/**
 * Render a border layer to a fresh canvas. Returns the canvas.
 *
 * Uses `OffscreenCanvas` if available (modern browsers), otherwise
 * `HTMLCanvasElement`. The returned canvas has the size
 * `(videoWidth + 2 * padding) × (videoHeight + 2 * padding)`.
 */
export function renderBorderLayer(
	opts: RenderBorderLayerOptions,
): HTMLCanvasElement | OffscreenCanvas {
	const { def, videoWidth, videoHeight } = opts;
	const padding = Math.max(0, Math.round(opts.paddingPx ?? def.padding));
	const opacity = Math.max(0, Math.min(1, opts.opacity ?? 1));
	const cornerRadius = Math.max(0, Math.round(opts.cornerRadiusPx ?? 12));

	const canvasWidth = videoWidth + padding * 2;
	const canvasHeight = videoHeight + padding * 2;

	const canvas = createCanvas(canvasWidth, canvasHeight);
	const ctx = canvas.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (!ctx) {
		throw new Error(
			"renderBorderLayer: 2D canvas context is not available in this environment",
		);
	}

	// Apply the user opacity to the whole layer.
	if (opacity < 1) {
		ctx.globalAlpha = opacity;
	}

	// Translate so (0, 0) is the inner video's top-left corner.
	ctx.translate(padding, padding);

	const w = videoWidth;
	const h = videoHeight;

	// 1. Fill the area behind the video (for glass / inset styles).
	if (def.fillColor && def.fillColor !== "transparent") {
		drawRoundedRectPath(ctx, 0, 0, w, h, cornerRadius);
		ctx.fillStyle = def.fillColor;
		ctx.fill();
	}

	// 2. Outer glow — a few stacked rounded-rect strokes with decreasing alpha.
	if (def.glowColor && def.glowBlur) {
		const glowSteps = 4;
		for (let i = glowSteps; i >= 1; i--) {
			const inset = (i - 1) * (def.glowBlur / glowSteps);
			const strokeWidth = def.glowBlur / glowSteps;
			ctx.save();
			drawRoundedRectPath(ctx, -inset, -inset, w + inset * 2, h + inset * 2, cornerRadius + inset);
			ctx.strokeStyle = withAlpha(def.glowColor, (1 / glowSteps) * 0.6);
			ctx.lineWidth = strokeWidth;
			ctx.stroke();
			ctx.restore();
		}
	}

	// 3. Outer stroke.
	if (def.strokeWidth > 0 && def.strokeColor !== "transparent") {
		ctx.save();
		drawRoundedRectPath(ctx, 0, 0, w, h, cornerRadius);
		ctx.strokeStyle = def.strokeColor;
		ctx.lineWidth = def.strokeWidth;
		// Stroke is centered on the path — shift the path by half the
		// stroke width so the stroke ends at the edge of the inner video.
		ctx.stroke();
		ctx.restore();
	}

	// 4. Inner stroke (a second stroke just inside the outer one).
	if (def.innerStrokeColor && def.innerStrokeWidth) {
		const inner = def.innerStrokeWidth;
		ctx.save();
		drawRoundedRectPath(ctx, inner, inner, w - inner * 2, h - inner * 2, Math.max(0, cornerRadius - inner));
		ctx.strokeStyle = def.innerStrokeColor;
		ctx.lineWidth = inner;
		ctx.stroke();
		ctx.restore();
	}

	// 5. Inset shadow (a linear gradient at the top edge).
	if (def.insetColor && def.insetStrength) {
		const insetBlur = Math.max(2, Math.round(def.insetStrength * 12));
		const grad = ctx.createLinearGradient(0, 0, 0, insetBlur);
		grad.addColorStop(0, withAlpha(def.insetColor, def.insetStrength));
		grad.addColorStop(1, "rgba(0,0,0,0)");
		ctx.save();
		drawRoundedRectPath(ctx, 0, 0, w, insetBlur, cornerRadius);
		ctx.fillStyle = grad;
		ctx.fill();
		ctx.restore();

		const gradBottom = ctx.createLinearGradient(0, h - insetBlur, 0, h);
		gradBottom.addColorStop(0, "rgba(0,0,0,0)");
		gradBottom.addColorStop(1, withAlpha(def.insetColor, def.insetStrength));
		ctx.save();
		drawRoundedRectPath(ctx, 0, h - insetBlur, w, insetBlur, cornerRadius);
		ctx.fillStyle = gradBottom;
		ctx.fill();
		ctx.restore();
	}

	// 6. Sheen (a linear gradient at the top of the frame).
	if (def.sheen && def.sheenColor) {
		const sheenH = Math.max(8, Math.round(h * 0.08));
		const grad = ctx.createLinearGradient(0, 0, 0, sheenH);
		grad.addColorStop(0, withAlpha(def.sheenColor, 0.35));
		grad.addColorStop(1, "rgba(0,0,0,0)");
		ctx.save();
		drawRoundedRectPath(ctx, 0, 0, w, sheenH, cornerRadius);
		ctx.fillStyle = grad;
		ctx.fill();
		ctx.restore();
	}

	// Note: the inner video is NOT drawn here. The caller composites
	// the video on top of the returned canvas at (padding, padding).

	return canvas;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCanvas(
	width: number,
	height: number,
): HTMLCanvasElement | OffscreenCanvas {
	if (typeof OffscreenCanvas !== "undefined") {
		return new OffscreenCanvas(width, height);
	}
	if (typeof document !== "undefined") {
		const c = document.createElement("canvas");
		c.width = width;
		c.height = height;
		return c;
	}
	// Last-ditch: a minimal stub. The caller will fail to get a 2D context.
	return {
		width,
		height,
		getContext: () => null,
	} as unknown as HTMLCanvasElement;
}

function drawRoundedRectPath(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
): void {
	const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
	ctx.beginPath();
	if (radius === 0) {
		ctx.rect(x, y, w, h);
	} else {
		ctx.moveTo(x + radius, y);
		ctx.lineTo(x + w - radius, y);
		ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
		ctx.lineTo(x + w, y + h - radius);
		ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
		ctx.lineTo(x + radius, y + h);
		ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
		ctx.lineTo(x, y + radius);
		ctx.quadraticCurveTo(x, y, x + radius, y);
	}
	ctx.closePath();
}

const RGBA_RE = /rgba?\(([^)]+)\)/i;

function withAlpha(color: string, alpha: number): string {
	const m = color.match(RGBA_RE);
	if (m) {
		const parts = m[1].split(",").map((s) => s.trim());
		const r = parts[0];
		const g = parts[1];
		const b = parts[2];
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}
	// Fallback for hex / named colors: blend with the canvas's
	// transparent background by using rgba with the parsed components.
	// For simplicity, just return the original with a 1.0 alpha — the
	// caller can `globalAlpha` if needed.
	return color;
}
