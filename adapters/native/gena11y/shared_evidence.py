import hashlib
import json
SOURCE_SCS = ('1.1.1', '1.4.1', '3.3.1', '2.4.4', '4.1.2', '1.4.3')
TWELVE_SCS = frozenset(SOURCE_SCS) | {'1.4.13', '2.1.1', '2.1.2', '2.4.3', '2.4.7', '4.1.3'}
VARIANT = 'GenA11y-shared-extraction-neutral-IA-rules12'

def extract_bundle(driver, extract_for_sc, ledger):
    outputs = {}
    for sc in SOURCE_SCS:
        with ledger.span('tool', 'existing-gena11y-extractor', sourceSC=sc):
            outputs[sc] = extract_for_sc(driver, sc)
        if outputs[sc] is None:
            raise ValueError(f'Existing GenA11y extractor {sc} returned None')
    return outputs

def evidence_records(bundle):
    records = []

    def text(label, value):
        value = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        records.append({'type': 'text', 'text': label + '\n' + value})

    def collection(label, value):
        if isinstance(value, dict):
            text(label + ' inventory', {k: len(v) if isinstance(v, list) else 1 for k, v in value.items()})
            for key, items in value.items():
                for item in items if isinstance(items, list) else [items]:
                    text(label + ' / ' + key, item)
        else:
            text(label + ' inventory', {'items': len(value)})
            for item in value:
                text(label, item)

    def image(label, data):
        text('Screenshot', label)
        records.append({'type': 'image', 'data': data})
    collection('Visual element HTML', bundle['1.1.1'])
    image('GenA11y use-of-color page screenshot', bundle['1.4.1']['screenshot'])
    image('GenA11y error-identification page screenshot', bundle['3.3.1'])
    collection('Link context HTML', bundle['2.4.4'])
    collection('Name/role element HTML', bundle['4.1.2'])
    contrast, backgrounds = bundle['1.4.3']
    collection('Contrast HTML and computed styles', contrast)
    for html, data in backgrounds.items():
        text('Background-image element', html)
        image('GenA11y background-image contrast crop', data)
    return records

def chunk_records(records, chunk_data):
    estimates = [dict(index=i, text=r['text'] if r['type'] == 'text' else 'image ' * 700) for i, r in enumerate(records)]
    return [[records[item['index']] for item in chunk] for chunk in chunk_data(estimates, threshold_tokens=20000, max_chunk_tokens=5000)]

def bundle_hash(bundle):
    return hashlib.sha1(json.dumps(bundle, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def judge_bundle(sc, bundle, detector):
    if sc not in TWELVE_SCS:
        raise ValueError(f'Criterion outside the frozen twelve-SC scope: {sc}')
    records = evidence_records(bundle)
    chunks = chunk_records(records, detector.chunk_data)

    def build(chunk):
        blocks = [detector._text_block(detector._INTERA11Y_RULES[sc] + '\nEach element includes its observed XPath where available.\nThe input is a page-wide bundle from the existing GenA11y extractors. Evaluate only the requested criterion using this supplied evidence.\n------------------\n')]
        for r in chunk:
            blocks.append(detector._text_block(r['text']) if r['type'] == 'text' else detector._b64_image_block(r['data']))
        return blocks
    responses = detector._call_chunks(chunks, build)
    result = detector.aggregate_responses(responses)
    counts = {}
    for response in responses:
        for verdict, count in response.get('elementVerdicts', {}).items():
            counts[verdict] = counts.get(verdict, 0) + count
    return {**result, 'elementVerdicts': counts, 'chunks': len(responses)}
