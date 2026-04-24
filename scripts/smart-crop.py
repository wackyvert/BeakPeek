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


def box_from_detection(value, width, height):
    parts = [float(part.strip()) for part in value.split(",")]
    if len(parts) != 4:
        raise ValueError("--box must be x,y,width,height")

    x, y, box_w, box_h = parts
    if max(abs(x), abs(y), abs(box_w), abs(box_h)) <= 1.0:
        x *= width
        box_w *= width
        y *= height
        box_h *= height

    pad_x = max(width * 0.025, box_w * 0.45)
    pad_y = max(height * 0.025, box_h * 0.45)
    return (
        max(0, x - pad_x),
        max(0, y - pad_y),
        min(width, x + box_w + pad_x),
        min(height, y + box_h + pad_y),
    )


def component_boxes(mask):
    height, width = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    boxes = []

    for start_y, start_x in zip(*np.where(mask)):
        if visited[start_y, start_x]:
            continue

        stack = [(int(start_x), int(start_y))]
        visited[start_y, start_x] = True
        min_x = max_x = int(start_x)
        min_y = max_y = int(start_y)
        count = 0

        while stack:
            x, y = stack.pop()
            count += 1
            min_x = min(min_x, x)
            max_x = max(max_x, x)
            min_y = min(min_y, y)
            max_y = max(max_y, y)

            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < width and 0 <= ny < height and mask[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((nx, ny))

        boxes.append((min_x, min_y, max_x + 1, max_y + 1, count))

    return boxes


def colored_subject_crop(arr, width, height, aspect):
    sh, sw = arr.shape[:2]
    r = arr[:, :, 0]
    g = arr[:, :, 1]
    b = arr[:, :, 2]
    max_rgb = arr.max(axis=2)
    min_rgb = arr.min(axis=2)
    saturation = (max_rgb - min_rgb) / np.maximum(max_rgb, 1)

    yellow = (r > 95) & (g > 85) & (r > b * 1.42) & (g > b * 1.25)
    red = (r > 90) & (r > g * 1.12) & (r > b * 1.16)
    mask = (saturation > 0.23) & (yellow | red)

    boxes = []
    for left, top, right, bottom, area in component_boxes(mask):
        box_w = right - left
        box_h = bottom - top
        if area < sw * sh * 0.00035 or area > sw * sh * 0.06:
            continue
        if box_w < 5 or box_h < 5:
            continue
        fill = area / max(box_w * box_h, 1)
        if fill < 0.08:
            continue
        mean_sat = float(saturation[top:bottom, left:right][mask[top:bottom, left:right]].mean())
        lower_weight = 1.0 + 0.35 * ((top + bottom) / 2 / sh)
        score = area * mean_sat * lower_weight
        boxes.append((score, left, top, right, bottom))

    if not boxes:
        return None

    _, left, top, right, bottom = max(boxes, key=lambda item: item[0])
    scale_x = width / sw
    scale_y = height / sh
    bird_box = (
        left * scale_x,
        top * scale_y,
        right * scale_x,
        bottom * scale_y,
    )
    bird_w = bird_box[2] - bird_box[0]
    bird_h = bird_box[3] - bird_box[1]
    pad_x = max(width * 0.025, bird_w * 0.85)
    pad_y = max(height * 0.025, bird_h * 0.85)
    padded = (
        max(0, bird_box[0] - pad_x),
        max(0, bird_box[1] - pad_y),
        min(width, bird_box[2] + pad_x),
        min(height, bird_box[3] + pad_y),
    )
    return expand_to_aspect(padded, width, height, aspect), 0.95


def find_crop(image, aspect=16 / 9):
    width, height = image.size
    if width < 64 or height < 64:
        return (0, 0, width, height), 0.0

    small = image.copy()
    small.thumbnail((420, 420), Image.Resampling.LANCZOS)
    arr = np.asarray(small).astype(np.float32)
    sh, sw = arr.shape[:2]

    colored = colored_subject_crop(arr, width, height, aspect)
    if colored:
        return colored

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
    parser.add_argument("--box", help="Detection box as x,y,width,height in pixels or normalized units.")
    parser.add_argument("--quality", type=int, default=92)
    args = parser.parse_args()

    image = ImageOps.exif_transpose(Image.open(args.input)).convert("RGB")
    aspect = parse_aspect(args.aspect)
    if args.box:
        box = expand_to_aspect(box_from_detection(args.box, image.size[0], image.size[1]), image.size[0], image.size[1], aspect)
        score = 1.0
    else:
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
