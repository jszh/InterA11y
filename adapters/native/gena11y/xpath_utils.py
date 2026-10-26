_GET_XPATH_JS = "return (function getXPath(el) {\n    if (!el || el.nodeType !== 1) return '';\n    var parts = [];\n    while (el && el.nodeType === 1) {\n        var idx = 1;\n        var sib = el.previousSibling;\n        while (sib) {\n            if (sib.nodeType === 1 && sib.tagName === el.tagName) idx++;\n            sib = sib.previousSibling;\n        }\n        parts.unshift(el.tagName.toLowerCase() + '[' + idx + ']');\n        el = el.parentNode;\n    }\n    return '/' + parts.join('/');\n})(arguments[0])\n"

def get_element_xpath(driver, element):
    try:
        return driver.execute_script(_GET_XPATH_JS, element) or ''
    except Exception:
        return ''

def format_with_xpath(outer_html, xpath):
    if xpath:
        return f'[path: {xpath}]\n{outer_html}'
    return outer_html

def extract_outer_html_and_xpath(driver, element):
    try:
        outer_html = element.get_attribute('outerHTML') or ''
        xpath = get_element_xpath(driver, element)
        return (outer_html, xpath)
    except Exception:
        return ('', '')

def build_xpath_map(driver, elements):
    m = {}
    for el in elements:
        html, xpath = extract_outer_html_and_xpath(driver, el)
        if html and xpath and (html not in m):
            m[html] = xpath
    return m

def resolve_xpath(html_snippet, xpath_map):
    if not html_snippet:
        return None
    if html_snippet in xpath_map:
        return xpath_map[html_snippet]
    snippet_stripped = html_snippet.strip()
    for known, xpath in xpath_map.items():
        k = known.strip()
        if snippet_stripped in k or k in snippet_stripped:
            return xpath
    return None
