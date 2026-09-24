from flask import Flask, request, jsonify, send_from_directory
from pathlib import Path
import json
import uuid
import os
import cloudinary
import cloudinary.uploader

app = Flask(__name__)

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data.json"
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# Cloudinary Konfiguration über Umgebungsvariablen oder Fallback
cloudinary.config(
    cloud_name=os.environ.get("CLOUDINARY_CLOUD_NAME", ""),
    api_key=os.environ.get("CLOUDINARY_API_KEY", ""),
    api_secret=os.environ.get("CLOUDINARY_API_SECRET", ""),
    secure=True
)

DEFAULT_DATA = {
    "dishes": [
        {
            "id": "f1",
            "name": "Nudeln mit Tomatensoße",
            "isEmergency": True,
            "isMeat": False,
            "isHighCarb": True,
            "ingredients": "500g Spaghetti\n1 Dose gehackte Tomaten\n1 Zwiebel\n2 Knoblauchzehen\nOlivenöl, Salz, Pfeffer, Basilikum",
            "instructions": "1. Nudeln in Salzwasser al dente kochen.\n2. Zwiebel und Knoblauch fein hacken, in Olivenöl andünsten.\n3. Tomaten hinzufügen und 10 Min. köcheln lassen.\n4. Mit Salz, Pfeffer und Basilikum abschmecken.",
            "image": ""
        },
        {
            "id": "f2",
            "name": "Kartoffelpüree mit Spiegelei",
            "isEmergency": False,
            "isMeat": False,
            "isHighCarb": True,
            "ingredients": "1kg mehlige Kartoffeln\n50g Butter\n150ml Milch\nMuskatnuss\n4 Eier",
            "instructions": "1. Kartoffeln schälen, würfeln und weichkochen.\n2. Mit Milch und Butter zerstampfen, mit Muskat und Salz abschmecken.\n3. Eier in einer Pfanne als Spiegeleier braten und dazu servieren.",
            "image": ""
        },
        {
            "id": "f3",
            "name": "Pfannkuchen",
            "isEmergency": True,
            "isMeat": False,
            "isHighCarb": True,
            "ingredients": "300g Mehl\n500ml Milch\n3 Eier\n1 Prise Salz\nButter zum Ausbacken",
            "instructions": "1. Alle Zutaten zu einem glatten Teig verrühren.\n2. Teig 10 Min. ruhen lassen.\n3. Portionsweise in einer heißen Pfanne mit Butter goldgelb backen.",
            "image": ""
        }
    ],
    "plan": []
}

import requests

JSONBIN_BIN_ID = os.environ.get("JSONBIN_BIN_ID", "")
JSONBIN_API_KEY = os.environ.get("JSONBIN_API_KEY", "")

def load_data():
    # 1. Wenn JSONBin konfiguriert ist, Daten aus der Cloud laden
    if JSONBIN_BIN_ID and JSONBIN_API_KEY:
        try:
            url = f"https://api.jsonbin.io/v3/b/{JSONBIN_BIN_ID}/latest"
            headers = {"X-Master-Key": JSONBIN_API_KEY}
            res = requests.get(url, headers=headers, timeout=5)
            if res.ok:
                return res.json().get("record", DEFAULT_DATA)
        except Exception as e:
            print(f"Fehler beim Laden von JSONBin: {e}")

    # 2. Lokaler Fallback auf Festplatte
    if not DATA_FILE.exists():
        save_data(DEFAULT_DATA)
        return DEFAULT_DATA
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return DEFAULT_DATA

def save_data(data):
    # 1. Wenn JSONBin konfiguriert ist, direkt in die Cloud speichern
    if JSONBIN_BIN_ID and JSONBIN_API_KEY:
        try:
            url = f"https://api.jsonbin.io/v3/b/{JSONBIN_BIN_ID}"
            headers = {
                "Content-Type": "application/json",
                "X-Master-Key": JSONBIN_API_KEY
            }
            requests.put(url, headers=headers, json=data, timeout=5)
        except Exception as e:
            print(f"Fehler beim Speichern in JSONBin: {e}")

    # 2. Lokaler Fallback
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")

@app.route("/styles.css")
def styles():
    return send_from_directory(BASE_DIR, "styles.css")

@app.route("/app.js")
def javascript():
    return send_from_directory(BASE_DIR, "app.js")

@app.route("/manifest.json")
def manifest():
    return send_from_directory(BASE_DIR, "manifest.json")

@app.route("/icon.png")
def icon():
    return send_from_directory(BASE_DIR, "icon.png")

@app.route("/uploads/<filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_DIR, filename)

@app.route("/api/data", methods=["GET"])
def get_data():
    return jsonify(load_data())

@app.route("/api/dishes", methods=["POST"])
def save_dish():
    data = load_data()
    payload = request.json
    dish_id = payload.get("id") or f"dish-{uuid.uuid4().hex[:8]}"
    
    # isMeat: True (Fleisch), False (Veggie), "baking" (Backen/Kuchen) oder None (Flexibel)
    raw_meat = payload.get("isMeat")
    if raw_meat == "baking":
        meat_val = "baking"
    elif raw_meat is True:
        meat_val = True
    elif raw_meat is False:
        meat_val = False
    else:
        meat_val = None

    new_dish = {
        "id": dish_id,
        "name": payload.get("name", "").strip(),
        "sourceUrl": payload.get("sourceUrl", "").strip(),
        "isEmergency": bool(payload.get("isEmergency", False)),
        "isMeat": meat_val,
        "isHighCarb": bool(payload.get("isHighCarb", False)),
        "ingredients": payload.get("ingredients", "").strip(),
        "instructions": payload.get("instructions", "").strip(),
        "image": payload.get("image", "").strip(),         # Der Screenshot / Infomaterial
        "previewImage": payload.get("previewImage", "").strip() # Das echte Foto für die App-Ansicht
    }
    
    existing_index = next((i for i, d in enumerate(data["dishes"]) if d["id"] == dish_id), None)
    if existing_index is not None:
        data["dishes"][existing_index] = new_dish
    else:
        data["dishes"].append(new_dish)
        
    save_data(data)
    return jsonify({"status": "success", "dish": new_dish})

@app.route("/api/dishes/<dish_id>", methods=["DELETE"])
def delete_dish(dish_id):
    data = load_data()
    data["dishes"] = [d for d in data["dishes"] if d["id"] != dish_id]
    save_data(data)
    return jsonify({"status": "success"})

@app.route("/api/plan", methods=["POST"])
def save_plan():
    data = load_data()
    data["plan"] = request.json.get("plan", [])
    save_data(data)
    return jsonify({"status": "success"})

@app.route("/api/upload", methods=["POST"])
def upload_image():
    if "image" not in request.files:
        return jsonify({"error": "Keine Datei gesendet"}), 400
    file = request.files["image"]
    if file.filename == "":
        return jsonify({"error": "Kein Dateiname"}), 400

    # 1. Wenn Cloudinary konfiguriert ist, direkt in die Cloud laden
    if os.environ.get("CLOUDINARY_CLOUD_NAME"):
        try:
            upload_result = cloudinary.uploader.upload(
                file,
                folder="smartbite_recipes",
                resource_type="image"
            )
            # Liefert die permanente HTTPS-URL von Cloudinary zurück
            return jsonify({"imageUrl": upload_result.get("secure_url")})
        except Exception as e:
            print(f"Cloudinary Upload Fehler: {e}")
            return jsonify({"error": "Upload fehlgeschlagen"}), 500

    # 2. Lokaler Fallback (für Entwicklung auf dem PC)
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in [".jpg", ".jpeg", ".png", ".webp", ".gif"]:
        return jsonify({"error": "Ungültiges Format"}), 400
        
    filename = f"{uuid.uuid4().hex}{ext}"
    file.save(UPLOAD_DIR / filename)
    return jsonify({"imageUrl": f"/uploads/{filename}"})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)