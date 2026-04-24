#!/usr/bin/env python3
import argparse
import json
import time

import numpy as np
from PIL import Image
import tensorflow as tf


def main():
    parser = argparse.ArgumentParser(description="Classify a feeder snapshot with a TFLite model.")
    parser.add_argument("image")
    parser.add_argument("--model", required=True)
    parser.add_argument("--labels", required=True)
    parser.add_argument("--camera-id", default="unknown")
    args = parser.parse_args()

    interpreter = tf.lite.Interpreter(model_path=args.model)
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()[0]
    output_details = interpreter.get_output_details()[0]

    with open(args.labels, "r", encoding="utf-8") as labels_file:
        labels = json.load(labels_file)

    image = Image.open(args.image).convert("RGB").resize(
        (input_details["shape"][2], input_details["shape"][1])
    )
    array = np.array(image)

    if input_details["dtype"] == np.uint8:
        tensor = np.expand_dims(array, axis=0).astype(np.uint8)
    else:
        tensor = np.expand_dims(array / 255.0, axis=0).astype(np.float32)

    interpreter.set_tensor(input_details["index"], tensor)
    interpreter.invoke()
    scores = interpreter.get_tensor(output_details["index"])[0]
    index = int(np.argmax(scores))

    print(json.dumps({
        "timestamp": int(time.time() * 1000),
        "cameraId": args.camera_id,
        "predictionIndex": index,
        "label": labels[index],
        "confidence": float(scores[index]),
    }))


if __name__ == "__main__":
    main()
