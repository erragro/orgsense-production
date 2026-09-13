# Production: serve pre-built static assets with nginx
# Build is done on CI/local: npm run build → dist/
FROM nginxinc/nginx-unprivileged:1.27-alpine

# Remove default nginx content
USER root
RUN rm -rf /usr/share/nginx/html/*

# Copy pre-built static assets
COPY dist /usr/share/nginx/html

# nginx config: serve SPA with HTML5 history fallback
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY security-headers.conf /etc/nginx/security-headers.conf
USER 101
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
