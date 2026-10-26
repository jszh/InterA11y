from typing import Any, Literal, Union
from pydantic import ConfigDict, Field, create_model

def argument_model(name, schema):

    def convert(label, spec):
        if 'enum' in spec:
            return Literal[tuple(spec['enum'])]
        kind = spec.get('type')
        if kind == 'array':
            return list[convert(label + 'Item', spec.get('items', {}))]
        if kind == 'object':
            fields = {}
            required = set(spec.get('required', []))
            for key, value in spec.get('properties', {}).items():
                annotation = convert(label + '_' + key, value)
                default = ... if key in required else None
                if default is None:
                    annotation = Union[annotation, None]
                fields[key] = (annotation, Field(default, description=value.get('description')))
            return create_model(label, __config__=ConfigDict(extra='forbid', strict=True), **fields)
        return {'string': str, 'number': float, 'integer': int, 'boolean': bool}.get(kind, Any)
    return convert(name + 'Arguments', schema)
