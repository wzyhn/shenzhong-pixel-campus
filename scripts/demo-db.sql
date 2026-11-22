CREATE ROLE campus_demo_migrator LOGIN PASSWORD 'demo';
CREATE ROLE campus_demo_app LOGIN PASSWORD 'demo';
GRANT CREATE ON DATABASE campus_demo TO campus_demo_migrator;
CREATE SCHEMA paperplane_campus AUTHORIZATION campus_demo_migrator;
GRANT USAGE ON SCHEMA paperplane_campus TO campus_demo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE campus_demo_migrator IN SCHEMA paperplane_campus
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_demo_app;
