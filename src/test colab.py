from ultralytics import YOLO
from google.colab import files
import matplotlib.pyplot as plt
from huggingface_hub import hf_hub_download

model_path = hf_hub_download(repo_id="mosesb/best-comic-panel-detection", filename="best.pt")

model = YOLO(model_path)

uploaded = files.upload()
file_name = list(uploaded.keys())[0]

results = model.predict(file_name, conf=0.25)

results[0].show()