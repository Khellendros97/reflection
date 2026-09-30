"""差异分析：把截图差异量化，并映射到具体元素。"""
import sys, os, json
import numpy as np
from PIL import Image, ImageChops


def analyze(a_path, b_path):
    a = Image.open(a_path).convert('RGB')
    b = Image.open(b_path).convert('RGB')
    if a.size != b.size:
        return {'error': 'size mismatch', 'a': a.size, 'b': b.size}
    arr = np.asarray(ImageChops.difference(a, b))
    mask = arr.sum(axis=2) > 0
    nz = np.argwhere(mask)
    out = {
        'a': os.path.basename(a_path),
        'b': os.path.basename(b_path),
        'differentPixels': int(len(nz)),
        'totalPixels': a.size[0] * a.size[1],
        'maxChannelDelta': int(arr.max()) if len(nz) else 0,
    }
    if len(nz):
        out['bbox'] = [int(nz[:, 1].min()), int(nz[:, 0].min()),
                       int(nz[:, 1].max()), int(nz[:, 0].max())]
        out['rowBands'] = sorted(set(int(y) // 20 * 20 for y in nz[:, 0]))
        # 归一化严重度：差异像素占比 × 最大通道差
        out['severity'] = round(len(nz) / (a.size[0] * a.size[1]) * 255, 4)
    else:
        out['bbox'] = None
        out['severity'] = 0.0
    return out


if __name__ == '__main__':
    d = sys.argv[1]
    base = sys.argv[2]
    for f in sys.argv[3:]:
        pa, pb = os.path.join(d, base), os.path.join(d, f)
        if not os.path.exists(pb):
            continue
        r = analyze(pa, pb)
        print(json.dumps(r, ensure_ascii=False))
