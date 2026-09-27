import json
import urllib.request

class VTGGroundClient:
    def __init__(self, base_url, timeout_seconds=90.0):
        self.url = str(base_url).rstrip('/') + '/ground'
        self.timeout = float(timeout_seconds)

    def ground(self, query, moments, *, top_k_per_window=3,
               max_windows=30, final_top_k=20):
        payload = {
            'query': str(query), 'moments': list(moments),
            'top_k_per_window': int(top_k_per_window),
            'max_windows': int(max_windows),
            'final_top_k': int(final_top_k), 'nms_iou_threshold': 0.7,
        }
        req = urllib.request.Request(
            self.url, data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            data=json.loads(resp.read().decode('utf-8'))
        if not data.get('success', False): return []
        return data.get('proposals') or []
