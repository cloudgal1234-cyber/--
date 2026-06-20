#!/bin/bash
set -e

echo "🚀 Starting OmniAI..."

# Check for API key
if [ -z "$ANTHROPIC_API_KEY" ]; then
  if [ -f backend/.env ]; then
    export $(cat backend/.env | xargs)
  else
    echo "❌ ANTHROPIC_API_KEY is not set."
    echo "   Create backend/.env with: ANTHROPIC_API_KEY=your_key_here"
    echo "   Or: export ANTHROPIC_API_KEY=your_key_here"
    exit 1
  fi
fi

# Install deps if needed
cd backend
if [ ! -d ".venv" ]; then
  echo "📦 Creating virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate

echo "📦 Installing dependencies..."
pip install -q -r requirements.txt

echo "✅ Starting server at http://localhost:8000"
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
