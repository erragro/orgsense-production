import os
import weaviate
from dotenv import load_dotenv

load_dotenv()

host = os.getenv("WEAVIATE_HOST", "127.0.0.1")
port = os.getenv("WEAVIATE_HTTP_PORT", "8080")
client = weaviate.Client(url=f"http://{host}:{port}")

print(client.is_ready())

client.close()
