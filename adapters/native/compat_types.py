"""Value objects consumed by the native AgentLab decision adapter."""
from types import SimpleNamespace


class Part(SimpleNamespace):
    @classmethod
    def from_text(cls, text):
        return cls(text=text, inline_data=None)

    @classmethod
    def from_bytes(cls, data, mime_type):
        return cls(text=None, inline_data=SimpleNamespace(data=data, mime_type=mime_type))


GenerateContentConfig = HttpOptions = ToolConfig = FunctionCallingConfig = AutomaticFunctionCallingConfig = ThinkingConfig = SimpleNamespace
