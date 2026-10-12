CREATE ROLE wagering_app LOGIN PASSWORD 'app';
GRANT CONNECT ON DATABASE wagering TO wagering_app;