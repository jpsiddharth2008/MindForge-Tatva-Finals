import yaml
import hashlib
from pathlib import Path

def validate_corpus():
    corpus_dir = Path(__file__).parent
    attacks_file = corpus_dir / "attacks.yaml"
    benign_file = corpus_dir / "benign.yaml"
    
    with open(attacks_file, "r", encoding="utf-8") as f:
        attacks = yaml.safe_load(f)
    with open(benign_file, "r", encoding="utf-8") as f:
        benign = yaml.safe_load(f)
        
    all_items = attacks + benign
    
    # Check counts
    if len(attacks) != 25:
        raise ValueError(f"Expected 25 attacks, got {len(attacks)}")
    if len(benign) != 15:
        raise ValueError(f"Expected 15 benign items, got {len(benign)}")
        
    valid_channels = {"web", "email", "mcp"}
    valid_categories = {"direct_override", "role_play", "tool_invocation", "authority_spoofing", "monitor_addressed", "benign"}
    valid_labels = {"malicious", "benign"}
    valid_goals = {"exfiltrate", "refund_fraud", "role_change", "none"}
    
    seen_ids = set()
    
    for item in all_items:
        required_keys = {"id", "channel", "category", "label", "goal", "text", "rationale"}
        missing = required_keys - set(item.keys())
        if missing:
            raise ValueError(f"Item {item.get('id', 'UNKNOWN')} missing keys: {missing}")
            
        if item["id"] in seen_ids:
            raise ValueError(f"Duplicate ID found: {item['id']}")
        seen_ids.add(item["id"])
            
        if item["channel"] not in valid_channels:
            raise ValueError(f"Invalid channel '{item['channel']}' in {item['id']}")
        if item["category"] not in valid_categories:
            raise ValueError(f"Invalid category '{item['category']}' in {item['id']}")
        if item["label"] not in valid_labels:
            raise ValueError(f"Invalid label '{item['label']}' in {item['id']}")
        if item["goal"] not in valid_goals:
            raise ValueError(f"Invalid goal '{item['goal']}' in {item['id']}")
            
        if not item["text"].strip():
            raise ValueError(f"Empty text in {item['id']}")
        if not item["rationale"].strip():
            raise ValueError(f"Empty rationale in {item['id']}")

    # Generate SHA256
    sha256_hash = hashlib.sha256()
    with open(attacks_file, "rb") as f:
        sha256_hash.update(f.read())
    with open(benign_file, "rb") as f:
        sha256_hash.update(f.read())
        
    hash_hex = sha256_hash.hexdigest()
    
    with open(corpus_dir / "SHA256", "w", encoding="utf-8") as f:
        f.write(hash_hex + "\n")
        
    print("Validation successful!")
    print(f"Total items: {len(all_items)} (25 attacks, 15 benign)")
    print(f"Corpus SHA256: {hash_hex}")
    
if __name__ == "__main__":
    validate_corpus()
