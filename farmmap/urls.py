from django.urls import path
from . import views

urlpatterns = [
    path('', views.dashboard, name='dashboard'),
    path('map/', views.farm_map, name='farm_map'),
    path('detection/', views.disease_detection, name='disease_detection'),
    path('inventory/', views.tree_inventory, name='tree_inventory'),
    path('inventory/<str:tree_id>/', views.tree_details, name='tree_details'),
    path('reports/', views.reports, name='reports'),
]