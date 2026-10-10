# Small Python base image, standard library only -- this frontend has no
# dependencies beyond what ships with python3 (serve.py is a stdlib static server).
FROM python:3.12-alpine

WORKDIR /app

COPY index.html serve.py README.md ./
COPY static ./static

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 8793

ENTRYPOINT ["/app/entrypoint.sh"]
