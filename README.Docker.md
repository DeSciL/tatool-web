# Docker Setup for Tatool-Web

This document explains how to run tatool-web in a Docker container.

## Prerequisites

- Docker installed on your system
- Docker Compose installed (usually comes with Docker Desktop)
- MongoDB running independently (either on host machine or another container)

## Quick Start

### 1. Build the Docker Image

```bash
docker-compose build
```

### 2. Configure Environment Variables

Copy the example environment file and modify as needed:

```bash
cp .env.example .env
```

Edit `.env` to configure your database connection and other settings.

### 3. Run the Application

```bash
docker-compose up -d
```

The application will be available at http://localhost:3000

### 4. View Logs

```bash
docker-compose logs -f tatool-web
```

### 5. Stop the Application

```bash
docker-compose down
```

## Configuration

### MongoDB Connection

The default configuration assumes MongoDB is running on your host machine. The connection string is:

- **Windows/Mac Docker Desktop**: `mongodb://host.docker.internal:27017/tatool-web`
- **Linux**: `mongodb://172.17.0.1:27017/tatool-web` (or use `host.docker.internal` with Docker 20.10+)

If your MongoDB is running in another Docker container, update the `DB_URI` to point to the container name.

### Environment Variables

Key environment variables (see `.env.example` for full list):

- `NODE_ENV`: Set to `production` for production use
- `PORT`: Application port (default: 3000)
- `DB_URI`: MongoDB connection string
- `JWT_SECRET`: Secret key for JWT tokens (change in production!)
- `PROJECTS_PATH_TYPE`: Storage type for projects (`local`, `gcs`, or `legacy`)
- `PROJECTS_PATH`: Path to projects directory or GCS bucket name

### Data Persistence

The `docker-compose.yml` mounts `./app/projects` as a volume to persist project data between container restarts.

## Building and Running Without Docker Compose

### Build the Image

```bash
docker build -t tatool-web .
```

### Run the Container

```bash
docker run -d \
  --name tatool-web \
  -p 3000:3000 \
  -e DB_URI=mongodb://host.docker.internal:27017/tatool-web \
  -e JWT_SECRET=your-secret-key \
  -v $(pwd)/app/projects:/app/app/projects \
  --add-host=host.docker.internal:host-gateway \
  tatool-web
```

## Troubleshooting

### Cannot Connect to MongoDB on Host

If the container cannot connect to MongoDB on your host machine:

1. **Windows/Mac**: Ensure Docker Desktop is running and `host.docker.internal` resolves correctly
2. **Linux**: Use `172.17.0.1` or enable `host.docker.internal` support
3. **Firewall**: Ensure MongoDB port (27017) is accessible
4. **MongoDB Bind IP**: Ensure MongoDB is listening on `0.0.0.0` or the Docker network interface

### Permission Issues

If you encounter permission issues with mounted volumes:

```bash
# Ensure the app/projects directory exists and has proper permissions
mkdir -p app/projects
chmod 755 app/projects
```

### Health Check Failures

If the health check fails, check the logs:

```bash
docker-compose logs tatool-web
```

Common issues:
- MongoDB connection failure
- Missing environment variables
- Port conflicts

## Production Deployment

For production deployments:

1. **Change JWT_SECRET** to a strong, unique value
2. **Use environment-specific configuration** files or secrets management
3. **Configure proper logging** and monitoring
4. **Set up reverse proxy** (nginx/Apache) for HTTPS
5. **Enable resource limits** in docker-compose.yml:

```yaml
services:
  tatool-web:
    # ... other config ...
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
```

## Maintenance

### Update Application

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose up -d --build
```

### View Container Status

```bash
docker-compose ps
```

### Execute Commands in Container

```bash
docker-compose exec tatool-web sh
```

### Cleanup

Remove containers and volumes:

```bash
docker-compose down -v
```

Remove images:

```bash
docker rmi tatool-web
```
