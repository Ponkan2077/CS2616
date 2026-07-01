from django.urls import path
from django.contrib.auth import views as auth_views
from . import views

urlpatterns = [
    # Core pages
    path('', views.dashboard, name='dashboard'),
    path('map/', views.farm_map, name='farm_map'),
    path('detection/', views.disease_detection, name='disease_detection'),
    path('inventory/', views.tree_inventory, name='tree_inventory'),
    path('inventory/<str:tree_id>/', views.tree_details, name='tree_details'),
    path('reports/', views.reports, name='reports'),

    # Farm management
    path('farms/', views.farm_list, name='farm_list'),
    path('farms/create/', views.farm_create, name='farm_create'),
    path('farms/<str:farm_id>/', views.farm_detail, name='farm_detail'),

    # Farm selection
    path('select-farm/', views.select_farm, name='select_farm'),

    # Authentication
    path('login/', auth_views.LoginView.as_view(template_name='login.html'), name='login'),
    path('logout/', auth_views.LogoutView.as_view(), name='logout'),
    path('register/', views.register, name='register'),
]
