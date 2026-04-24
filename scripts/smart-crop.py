#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps


def normalize(values):
    values = values.astype(np.float32)
    low, high = np.percentile(values, [3, 97])
    if high <= low:
        return np.zeros_like(values, dtype=np.float32)
    return np.clip((values - low) / (high - low), 0.0, 1.0)


def expand_to_aspect(box, width, height, aspect):
    left, top, right, bottom = box
    center_x = (left + right) / 2
    center_y = (top + bottom) / 2
    crop_w = max(1, right - left)
    crop_h = max(1, bottom - top)

    if crop_w / crop_h < aspect:
        target_w = crop_h * aspect
        target_h = crop_h
    else:
        target_w = crop_w
        target_h = crop_w / aspect

    if target_w > width:
        target_w = width
        target_h = target_w / aspect
    if target_h > height:
        target_h = height
        target_w = target_h * aspect

    crop_w = max(1, min(width, int(round(target_w))))
    crop_h = max(1, min(height, int(round(crop_w / aspect))))
    if crop_h > height:
        crop_h = height
        crop_w = max(1, min(width, int(round(crop_h * aspect))))

    left = int(round(center_x - crop_w / 2))
    top = int(round(center_y - crop_h / 2))
    left = min(max(0, left), width - crop_w)
    top = min(max(0, top), height - crop_h)
    return (left, top, left + crop_w, top + crop_h)


def find_crop(image, aspect=16 / 9):
    width, height = image.size
    if width < 64 or height < 64:
        return (0, 0, width, height), 0.0

    small = image.copy()
    small.thumbnail((420, 420), Image.Resampling.LANCZOS)
    arr = np.asarray(small).astype(np.float32)
    sh, sw = arr.shape[:2]

    border = max(3, min(sw, sh) // 18)
    border_pixels = np.concatenate([
        arr[:border].reshape(-1, 3),
        arr[-border:].reshape(-1, 3),
        arr[:, :border].reshape(-1, 3),
        arr[:, -border:].reshape(-1, 3),
    ])
    background = np.median(border_pixels, axis=0)
    color_distance = normalize(np.linalg.norm(arr - background, axis=2))

    max_rgb = arr.max(axis=2)
    min_rgb = arr.min(axis=2)
    saturation = normalize((max_rgb - min_rgb) / np.maximum(max_rgb, 1))

    luminance = arr @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    gy, gx = np.gradient(luminance)
    edges = normalize(np.hypot(gx, gy))

    yy, xx = np.mgrid[0:sh, 0:sw]
    center_weight = 1.0 - np.clip(
        np.hypot((xx - sw / 2) / max(sw, 1), (yy - sh / 2) / max(sh, 1)) * 1.35,
        0.0,
        0.6,
    )

    saliency = (0.48 * color_distance + 0.30 * edges + 0.22 * saturation) * center_weight
    saliency_image = Image.fromarray(np.uint8(np.clip(saliency * 255, 0, 255)))
    saliency = np.asarray(saliency_image.filter(ImageFilter.GaussianBlur(radius=5))).astype(np.float32) / 255

    threshold = max(float(np.percentile(saliency, 78)), float(saliency.mean() + saliency.std() * 0.35))
    mask = saliency >= threshold
    ys, xs = np.where(mask)
    if xs.size < sw * sh * 0.012:
        return (0, 0, width, height), 0.0

    left = xs.min() / sw * width
    right = (xs.max() + 1) / sw * width
    top = ys.min() / sh * height
    bottom = (ys.max() + 1) / sh * height

    box_w = right - left
    box_h = bottom - top
    if box_w * box_h > width * height * 0.92:
        return (0, 0, width, height), float(saliency[mask].mean())

    pad_x = max(width * 0.04, box_w * 0.26)
    pad_y = max(height * 0.04, box_h * 0.26)
    padded = (
        max(0, left - pad_x),
        max(0, top - pad_y),
        min(width, right + pad_x),
        min(height, bottom + pad_y),
    )
    return expand_to_aspect(padded, width, height, aspect), float(saliency[mask].mean())


def parse_aspect(value):
    if ":" in value:
        left, right = value.split(":", 1)
        return float(left) / float(right)
    return float(value)


def main():
    parser = argparse.ArgumentParser(description="Create a bird-focused display crop.")
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--aspect", default="16:9")
    parser.add_argument("--quality", type=int, default=92)
    args = parser.parse_args()

    image = ImageOps.exif_transpose(Image.open(args.input)).convert("RGB")
    aspect = parse_aspect(args.aspect)
    box, score = find_crop(image, aspect=aspect)
    cropped = image.crop(box)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    cropped.save(args.output, "JPEG", quality=args.quality, optimize=True)

    print(json.dumps({
        "box": box,
        "score": score,
        "cropped": box != (0, 0, image.size[0], image.size[1]),
        "width": cropped.size[0],
        "height": cropped.size[1],
    }))


if __name__ == "__main__":
    main()
