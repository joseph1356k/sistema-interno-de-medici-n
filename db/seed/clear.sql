-- Borra los datos de demostracion. Identificados por prefijos conocidos, asi que
-- no puede tocar datos reales.
--
-- La logica vive en la funcion clear_demo_data() (migracion 0008), que es la
-- misma que usa el boton de la vista Salud: asi hay un solo sitio que sabe que es
-- demo y que no.
\set ON_ERROR_STOP on

select clear_demo_data() as borrado;

select 'datos de demostración borrados' as resultado;
